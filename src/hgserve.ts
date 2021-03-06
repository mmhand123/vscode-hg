
import { spawn, ChildProcess } from "child_process";
import { window, InputBoxOptions } from "vscode";
import { interaction } from "./interaction";
import { EventEmitter, Event } from "vscode";

export interface Deferred<T> {
    resolve: (c: T) => any,
    reject: (e) => any,
    promise: Promise<T>
}

export function defer<T>(): Deferred<T> {
    const deferred: Deferred<T> = Object.create(null);
    deferred.promise = new Promise<T>((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
    });
    return deferred;
}

const defaults = {
    hgOpts: ['serve', '--cmdserver', 'pipe']
};

export interface IExecutionResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

interface PipelineCommand {
    cmd: string;
    args: string[];
    result: Deferred<IExecutionResult>;
}

export class HgCommandServer {
    private hgPath: string;
    private config;
    private serverProcess: ChildProcess | undefined;
    private starting: boolean;
    private encoding: string;
    private capabilities;
    private commandQueue: PipelineCommand[];
    private stopWhenQueueEmpty: boolean;

    private constructor(config = {}, private logger: (text: string) => void) {
        // super();
        this.config = { ...defaults, ...config };
        this.commandQueue = [];
        this.starting = false;
    }

    public static async start(hgPath: string, repository: string, logger: (text: string) => void) {
        const config = {
            hgOpts: ['--config', 'ui.interactive=True', 'serve', '--cmdserver', 'pipe', '--cwd', repository]
        };
        const commandServer = new HgCommandServer(config, logger);
        return await commandServer.start(hgPath);
    }

	/*
		  Start the command server at a specified directory (path must already be an hg repository)
	 */
    private async start(hgPath: string): Promise<HgCommandServer> {
        this.hgPath = hgPath;
        this.serverProcess = await this.spawnCommandServerProcess(hgPath);
        this.attachListeners();
        return this;
    }

    /**	Stop the current command server process from running */
    public stop(force?: boolean) {
        if (!this.serverProcess) {
            return;
        }

        if (this.commandQueue.length && !force) {
            this.stopWhenQueueEmpty = true;
            return;
        }

        try {
            this.serverProcess.removeAllListeners("exit");
            this.serverProcess.stdout.removeAllListeners("data");
            this.serverProcess.stderr.removeAllListeners("data");
            this.serverProcess.stdin.end();
        }
        catch (e) {
            this.logger(`Failed to remove cmdserve listeners: ${e}`);
        }
        finally {
            this.serverProcess = undefined;
        }
    }

    /** Run a command */
    public runcommand(...args): Promise<IExecutionResult> {
        return this.enqueueCommand("runcommand", ...args);
    }

    /** Enqueue a command  */
    private enqueueCommand(cmd: string, ...args: string[]): Promise<IExecutionResult> {
        if (this.serverProcess) {
            const command: PipelineCommand = {
                cmd, args,
                result: defer<IExecutionResult>()
            }
            this.commandQueue.push(command);
            interaction.serverSendCommand(this.serverProcess, this.encoding, cmd, args);
            return command.result.promise;
        }

        return Promise.reject("HGCommandServer is not started")
    }

    private dequeueCommand(): PipelineCommand | undefined {
        return this.commandQueue.shift();
    }

    /** Spawn the hg cmdserver as a child process */
    private spawnCommandServerProcess(path: string): Promise<ChildProcess> {
        return new Promise<ChildProcess>((c, e) => {
            this.starting = true;
            const process = this.spawnHgServer(path);

            process.stdout.once("data", (data: Buffer) => {
                this.starting = false;
                const chan = String.fromCharCode(data.readUInt8(0));
                const bodyLength = data.readUInt32BE(1);
                const bodyData = data.slice(5, 5 + bodyLength);
                let body: string | number;
                if (chan === 'r') {
                    body = bodyData.readInt32BE(0);
                }
                else {
                    body = bodyData.toString(this.encoding).replace(/\0/g, "");
                }
                const { capabilities, encoding } = this.parseCapabilitiesAndEncoding(<string>body);
                this.capabilities = capabilities;
                this.encoding = encoding;

                if (!capabilities.includes("runcommand")) {
                    e("runcommand not available");
                }

                c(process);
            });
            process.stderr.on("data", (data) => {
                if (this.starting) {
                    return e(data);
                }
                return this.handleServerError(data);
            });
            process.on("exit", code => {
                if (process) {
                    process.removeAllListeners("exit");
                }
            });
        });
    }

	/*
	  Create the child process (exposed for unit testing mostly)
	 */

    spawnHgServer(path) {
        var processEnv, spawnOpts;
        processEnv = { "HGENCODING": "UTF-8", ...process.env };
        spawnOpts = {
            env: processEnv,
            cwd: path || process.cwd()
        };
        return spawn('hg', this.config.hgOpts, spawnOpts);
    };


	/*
	  Parse the capabilities and encoding when the cmd server starts up
	 */

    parseCapabilitiesAndEncoding(data: string) {
        let matches = /capabilities: (.*?)\nencoding: (.*?)$/.exec(data);
        if (!matches) {
            matches = /capabilities: (.*?)\nencoding: (.*?)\n(.*?)$/g.exec(data);
        }

        if (!matches) {
            throw new Error("Unable to parse capabilities: " + data);
        }

        const [_, caps, encoding] = matches;
        return {
            capabilities: caps.split(" "),
            encoding: encoding
        };
    };

    handleServerError(data) {
        console.error(data);
        // return this.emit("error", data);
    };

	/*
	  Send the raw command strings to the cmdserver over `stdin`
	 */

    /** Parse the Channel information, emit an event on the channel with the data. */
    async attachListeners() {
        const { serverProcess } = this;
        if (!serverProcess) {
            return;
        }

        let errorBuffers: (string | Buffer)[];
        let outputBodies: string[];
        let errorBodies: string[];
        let exitCode: number | undefined;

        function reset() {
            errorBodies = [];
            errorBuffers = [];
            outputBodies = [];
            exitCode = undefined;
        }

        reset();

        serverProcess.on("exit", (code) => {
            this.logger(`hg command server was closed unexpectedly: ${code}\n`);
            this.stop(true);
            this.start(this.hgPath);
        });

        serverProcess.stderr.on("data", data => errorBuffers.push(data));

        serverProcess.stdout.on("data", async (data: Buffer) => {
            let offset = 0;
            while (offset < data.length) {
                const chan = String.fromCharCode(data.readUInt8(offset)); // +1
                const length = data.readUInt32BE(offset + 1); // +4
                offset += 5;

                if (chan === RESULT_CHANNEL) {
                    // result channel
                    exitCode = data.readUInt32BE(offset);
                    offset += length;
                }
                else if (chan === LINE_CHANNEL) {
                    // line channel
                    const stdout = outputBodies.join("");
                    const response = await interaction.handleChoices(stdout, length);
                    interaction.serverSendLineInput(serverProcess, this.encoding, response);
                    offset += 0;
                }
                else {
                    // output or error channel
                    const bodySlice = data.slice(offset, offset + length);
                    const body = bodySlice.toString(this.encoding); //.replace(/\0/g, "");
                    if (chan === OUTPUT_CHANNEL) {
                        outputBodies.push(body);
                    }
                    else if (chan === ERROR_CHANNEL) {
                        errorBodies.push(body);
                    }
                    offset += length;
                }

                if (exitCode !== undefined) {
                    // server.stdout.removeAllListeners();
                    // server.stderr.removeAllListeners();

                    const stdout = outputBodies.join("");
                    const stderr = errorBodies.join("");
                    const result = <IExecutionResult>{
                        stdout, stderr, exitCode
                    }

                    reset();

                    const command = this.dequeueCommand();
                    if (command) {
                        command.result.resolve(result);
                    }

                    if (this.stopWhenQueueEmpty && this.commandQueue.length === 0) {
                        this.stop();
                        return;
                    }
                }
            }
        });
    }

}

function getChanName(chan: string) {
    switch (chan) {
        case "o": return "output";
        case "r": return "result";
        case "e": return "error";
        case "d": return "debug";
        default: throw new Error(`Unknown channel '${chan}'`);
    }
};

const LINE_CHANNEL = 'L';
const RESULT_CHANNEL = 'r';
const OUTPUT_CHANNEL = 'o';
const ERROR_CHANNEL = 'e';