// Copyright (C) 2023 Bryan A. Jones.
//
// This file is part of the CodeChat Editor. The CodeChat Editor is free
// software: you can redistribute it and/or modify it under the terms of the GNU
// General Public License as published by the Free Software Foundation, either
// version 3 of the License, or (at your option) any later version.
//
// The CodeChat Editor is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
// details.
//
// You should have received a copy of the GNU General Public License along with
// the CodeChat Editor. If not, see
// [http://www.gnu.org/licenses](http://www.gnu.org/licenses).
//
// # `extension.ts` - The CodeChat Editor Visual Studio Code extension
//
// This extension creates a webview (see `activation/deactivation`\_), then uses
// a websocket connection to the CodeChat Editor Server and Client to render
// editor text in that webview.
//
// ## Imports
//
// ### Node.js packages
import assert from "assert";
import util from "node:util";
import child_process from "node:child_process";

// ### Third-party packages
import escape from "escape-html";
import vscode from "vscode";
import { WebSocket } from "ws";

// ### Local packages
//
// None.
//
// ## Globals
const execFile = util.promisify(child_process.execFile);

enum CodeChatEditorClientLocation {
    html,
    browser,
}
// These globals are truly global: only one is needed for this entire plugin.
let websocket: WebSocket | undefined;
// Where the webclient resides: `html` for a webview panel embedded in VSCode;
// `browser` to use an external browser.
let codechat_client_location: CodeChatEditorClientLocation =
    CodeChatEditorClientLocation.html;
// True if the subscriptions to IDE change notifications have been registered.
let subscribed = false;

// A unique instance of these variables is required for each CodeChat panel.
// However, this code doesn't have a good UI way to deal with multiple panels,
// so only one is supported at this time.
//
// The webview panel used to display the CodeChat Client
let webview_panel: vscode.WebviewPanel | undefined;
// A timer used to wait for additional events (keystrokes, etc.) before
// performing a render.
let idle_timer: NodeJS.Timeout | undefined;
// Use a unique ID for each websocket message sent. See the Implementation
// section on Message IDs for more information.
let message_id = -9007199254740989;
// A map of message id to (timer id, callback) for all pending messages.
const pending_messages: Record<
    number,
    {
        timer_id: NodeJS.Timeout;
        callback: (succeeded: boolean) => void;
    }
> = {};
// The text editor containing the current file.
let current_editor: vscode.TextEditor | undefined;
// True to ignore the next change event, which is produced by applying an
// `Update` from the Client.
let ignore_change = false;

// ### Message types
//
// These mirror the same definitions in the Rust webserver, so that the two can
// exchange messages.
interface IdeType {
    VSCode: boolean;
}

interface CodeMirror {
    doc: string;
    doc_blocks: [];
}

interface CodeChatForWeb {
    metadata: { mode: "" };
    source: CodeMirror;
}

interface UpdateMessageContents {
    contents: CodeChatForWeb | undefined;
    cursor_position: number | undefined;
    scroll_position: number | undefined;
}

interface ResultOkTypes {
    LoadFile: string | null;
}

interface MessageResult {
    Ok?: "Void" | ResultOkTypes;
    Err?: string;
}

interface JointMessageContents {
    Update?: UpdateMessageContents;
    CurrentFile?: string | undefined;
    Opened?: IdeType;
    RequestClose?: null;
    LoadFile?: string;
    ClientHtml?: string;
    Result?: MessageResult;
}

interface JointMessage {
    id: number;
    message: JointMessageContents;
}

// ## Activation/deactivation
//
// This is invoked when the extension is activated. It either creates a new
// CodeChat Editor Server instance or reveals the currently running one.
export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "extension.codeChatEditorDeactivate",
            deactivate
        ),
        vscode.commands.registerCommand(
            "extension.codeChatEditorActivate",
            async () => {
                console.log("CodeChat Editor extension starting.");

                if (!subscribed) {
                    subscribed = true;

                    // Render when the text is changed by listening for the
                    // correct
                    // `event <https://code.visualstudio.com/docs/extensionAPI/vscode-api#Event>`\_.
                    context.subscriptions.push(
                        vscode.workspace.onDidChangeTextDocument((event) => {
                            // VSCode sends empty change events -- ignore these.
                            if (event.contentChanges.length === 0) {
                                return;
                            }
                            // If this change was produced by applying an
                            // `Update` from the Client, ignore it.
                            if (ignore_change) {
                                ignore_change = false;
                                return;
                            }
                            console.log(
                                `CodeChat Editor extension: text changed - ${
                                    event.reason
                                }, ${JSON.stringify(event.contentChanges)}.`
                            );
                            start_render();
                        })
                    );

                    // Render when the active editor changes.
                    context.subscriptions.push(
                        vscode.window.onDidChangeActiveTextEditor((_event) => {
                            current_file();
                        })
                    );
                }

                // Get the CodeChat Client's location from the VSCode
                // configuration.
                const codechat_client_location_str = vscode.workspace
                    .getConfiguration("CodeChatEditor.Server")
                    .get("ClientLocation");
                assert(typeof codechat_client_location_str === "string");
                switch (codechat_client_location_str) {
                    case "html":
                        codechat_client_location =
                            CodeChatEditorClientLocation.html;
                        break;

                    case "browser":
                        codechat_client_location =
                            CodeChatEditorClientLocation.browser;
                        break;

                    default:
                        assert(false);
                }

                // Create or reveal the webview panel; if this is an external
                // browser, we'll open it after the client is created.
                if (
                    codechat_client_location ===
                    CodeChatEditorClientLocation.html
                ) {
                    if (webview_panel !== undefined) {
                        // As below, don't take the focus when revealing.
                        webview_panel.reveal(undefined, true);
                    } else {
                        // Create a webview panel.
                        webview_panel = vscode.window.createWebviewPanel(
                            "CodeChat Editor",
                            "CodeChat Editor",
                            {
                                // Without this, the focus becomes this webview;
                                // setting this allows the code window open
                                // before this command was executed to retain
                                // the focus and be immediately rendered.
                                preserveFocus: true,
                                // Put this in the a column beside the current
                                // column.
                                viewColumn: vscode.ViewColumn.Beside,
                            },
                            // See WebViewOptions\_.
                            {
                                enableScripts: true,
                                // Note: Per the
                                // `docs <https://code.visualstudio.com/api/advanced-topics/remote-extensions#option-2-use-a-port-mapping>`\_\_,
                                // there's a way to map from ports on the
                                // extension host machine (which may be running
                                // remotely) to local ports the webview sees
                                // (since webviews always run locally). However,
                                // this doesn't support websockets, and should
                                // also be in place when using an external
                                // browser. Therefore, we don't supply
                                // `portMapping`.
                            }
                        );
                        // TODO: do I need to dispose of this and the following
                        // event handlers? I'm assuming that it will be done
                        // automatically when the object is disposed.
                        webview_panel.onDidDispose(async () => {
                            // Shut down the render client when the webview
                            // panel closes.
                            console.log(
                                "CodeChat Editor extension: shut down webview."
                            );
                            await stop_client();
                            webview_panel = undefined;
                        });

                        // Render when the webview panel is shown.
                        webview_panel.onDidChangeViewState(
                            (
                                _event: vscode.WebviewPanelOnDidChangeViewStateEvent
                            ) => {
                                // Only render if the webview was activated;
                                // this event also occurs when it's deactivated.
                                if (webview_panel?.active) {
                                    start_render();
                                }
                            }
                        );
                    }
                }

                // Provide a simple status display while the CodeChat Editor
                // Server is starting up.
                if (webview_panel !== undefined) {
                    // If we have an ID, then the GUI is already running; don't
                    // replace it.
                    webview_panel.webview.html =
                        "<h1>CodeChat Editor</h1><p>Loading...</p>";
                } else {
                    vscode.window.showInformationMessage(
                        "The CodeChat Editor is loading in an external browser..."
                    );
                }

                // Start the server.
                try {
                    console.log("CodeChat Editor extension: starting server.");
                    await run_server(["start"]);
                } catch (err) {
                    assert(err instanceof Error);
                    show_error(err.message);
                    return;
                }

                if (websocket === undefined) {
                    console.log(
                        "CodeChat Editor extension: opening websocket."
                    );

                    // Connect to the CodeChat Editor Server.
                    websocket = new WebSocket(
                        `ws://localhost:${get_port()}/vsc/ws-ide/${Math.random()}`
                    );

                    let was_error: boolean = false;

                    websocket.on("error", (err: ErrorEvent) => {
                        console.log(
                            `CodeChat Editor extension: error in Server connection: ${err.message}`
                        );
                        was_error = true;
                        show_error(
                            `Error communicating with the CodeChat Editor Server: ${err.message}. Re-run the CodeChat Editor extension to restart it.`
                        );
                        // The close event will be
                        // [emitted next](https://nodejs.org/api/net.html#net_event_error_1);
                        // that will handle cleanup.
                    });

                    websocket.on("close", (hadError: CloseEvent) => {
                        console.log(
                            "CodeChat Editor extension: closing websocket connection."
                        );
                        // If there was an error, the event handler above
                        // already provided the message. Note: the
                        // [parameter hadError](https://nodejs.org/api/net.html#net_event_close_1)
                        // only applies to transmission errors, not to any other
                        // errors which trigger the error callback. Therefore,
                        // I'm using the `was_error` flag instead to catch
                        // non-transmission errors.
                        if (!was_error && hadError) {
                            show_error(
                                "The connection to the CodeChat Editor Server was closed due to a transmission error. Re-run the CodeChat Editor extension to restart it."
                            );
                        }
                        websocket = undefined;
                        idle_timer = undefined;
                    });

                    websocket.on("open", () => {
                        console.log(
                            "CodeChat Editor extension: connected to server."
                        );
                        console.log(
                            "CodeChat Editor extension: sent Opened message."
                        );
                        assert(websocket !== undefined);
                        send_message({
                            Opened: {
                                VSCode:
                                    codechat_client_location ===
                                    CodeChatEditorClientLocation.html,
                            },
                        });
                        // For the external browser, we can immediately send the
                        // `CurrentFile` message. For the WebView, we must first
                        // wait to receive the HTML for the WebView (the
                        // `ClientHtml` message).
                        if (
                            codechat_client_location ===
                            CodeChatEditorClientLocation.browser
                        ) {
                            current_file();
                        }
                    });

                    websocket.on("message", (data) => {
                        // Parse the data into a message.
                        console.log(
                            `CodeChat Editor extension: Received data ${data}.`
                        );
                        const { id, message } = JSON.parse(
                            data.toString()
                        ) as JointMessage;
                        assert(id !== undefined);
                        assert(message !== undefined);
                        const keys = Object.keys(message);
                        console.assert(keys.length === 1);
                        const key = keys[0];
                        const value = Object.values(message)[0];

                        // Process this message.
                        switch (key) {
                            case "Update": {
                                const current_update =
                                    value as UpdateMessageContents;
                                console.log(
                                    `Update(cursor_position: ${current_update.cursor_position}, scroll_position: ${current_update.scroll_position})`
                                );
                                if (
                                    current_editor === undefined ||
                                    current_editor.document.isClosed
                                ) {
                                    console.log(
                                        "CodeChat Editor extension: Result = Error - no active text editor."
                                    );
                                    send_result(id, {
                                        Err: "No active text editor.",
                                    });
                                    break;
                                }
                                if (current_update.contents !== undefined) {
                                    // This will produce a change event, which
                                    // we'll ignore.
                                    ignore_change = true;
                                    current_editor.edit((editBuilder) => {
                                        editBuilder.replace(
                                            new vscode.Range(
                                                0,
                                                0,
                                                current_editor!.document.lineCount,
                                                0
                                            ),
                                            current_update.contents!.source.doc
                                        );
                                    });
                                }
                                console.log(
                                    "CodeChat Editor extension: sent Result = Ok."
                                );
                                send_result(id);
                                break;
                            }

                            case "CurrentFile": {
                                const current_file = value as string;
                                console.log(`CurrentFile(${current_file})`);
                                // TODO!
                                console.log(
                                    "CodeChat Editor extension: sent Result = Ok."
                                );
                                send_result(id);
                                break;
                            }

                            case "Result": {
                                // Cancel the timer for this message and remove
                                // it from `pending_messages`.
                                const pending_message = pending_messages[id];
                                if (pending_message !== undefined) {
                                    const { timer_id, callback } =
                                        pending_messages[id];
                                    clearTimeout(timer_id);
                                    // eslint-disable-next-line
                                    // n/no-callback-literal
                                    callback(true);
                                    delete pending_messages[id];
                                }

                                // Report if this was an error.
                                const result_contents = value as MessageResult;
                                if ("Err" in result_contents) {
                                    console.log(
                                        `Error in message ${id}: ${result_contents.Err}.`
                                    );
                                }
                                // TODO!
                                break;
                            }

                            case "LoadFile": {
                                const load_file = value as string;
                                console.log(`LoadFile(${load_file})`);
                                const contents =
                                    load_file ===
                                    vscode.window.activeTextEditor?.document
                                        .fileName
                                        ? vscode.window.activeTextEditor!.document.getText()
                                        : null;
                                console.log(
                                    `CodeChat Editor extension: sent Result = LoadFile(${contents}).`
                                );
                                send_result(id, {
                                    Ok: {
                                        LoadFile: contents,
                                    },
                                });
                                break;
                            }

                            case "ClientHtml": {
                                const client_html = value as string;
                                assert(webview_panel !== undefined);
                                webview_panel.webview.html = client_html;
                                console.log(
                                    "CodeChat Editor extension: sent Result = Ok."
                                );
                                send_result(id);
                                // Now that the Client is loaded, send the
                                // editor's current file to the server.
                                current_file();
                                break;
                            }

                            default:
                                console.log(
                                    `Unhandled message ${key}(${value})`
                                );
                                break;
                        }
                    });
                } else {
                    console.log(
                        "CodeChat Editor extension: connection already pending, so a new client wasn't created."
                    );
                }
            }
        )
    );
}

// On deactivation, close everything down.
export async function deactivate() {
    console.log("CodeChat extension: deactivating.");
    await stop_client();
    webview_panel?.dispose();
    console.log("CodeChat extension: deactivated.");
}

// ## Supporting functions
//
// Send a message expecting a result to the server.
const send_message = (
    message: JointMessageContents,
    callback: (succeeded: boolean) => void = (_) => 0
) => {
    const id = message_id;
    message_id += 3;
    const jm: JointMessage = {
        id,
        message,
    };
    assert(websocket);
    console.log(`CodeChat Editor extension: sending message id ${jm.id}.`);
    websocket.send(JSON.stringify(jm));
    pending_messages[id] = {
        timer_id: setTimeout(report_server_timeout, 2000, id),
        callback,
    };
};

// Report an error from the server.
const report_server_timeout = (message_id: number) => {
    // Invoke the callback with an error.
    pending_messages[message_id]?.callback(false);

    // Remove the message from the pending messages and report the error.
    delete pending_messages[message_id];
    console.log(`Error: server timeout for message id ${message_id}`);
};

// Send a result (a response to a message from the server) back to the server.
const send_result = (id: number, result: MessageResult = { Ok: "Void" }) => {
    // We can't simply call `send_message` because that function expects a
    // result message back from the server.
    const jm: JointMessage = {
        id,
        message: {
            Result: result,
        },
    };
    assert(websocket);
    websocket.send(JSON.stringify(jm));
};

// This is called after an event such as an edit, or when the CodeChat panel
// becomes visible. Wait a bit in case any other events occur, then request a
// render.
function start_render() {
    if (can_render()) {
        // Render after some inactivity: cancel any existing timer, then ...
        if (idle_timer !== undefined) {
            clearTimeout(idle_timer);
        }
        // ... schedule a render after 300 ms.
        idle_timer = setTimeout(() => {
            if (can_render()) {
                console.log("CodeChat Editor extension: starting render.");
                current_editor = vscode.window.activeTextEditor!;
                send_message({
                    Update: {
                        contents: {
                            metadata: { mode: "" },
                            source: {
                                doc: current_editor.document.getText(),
                                doc_blocks: [],
                            },
                        },
                        cursor_position: undefined,
                        scroll_position: undefined,
                    },
                });
            }
        }, 300);
    }
}

const current_file = () => {
    if (can_render()) {
        console.log("CodeChat Editor extension: sent CurrentFile message.");
        send_message(
            {
                CurrentFile: vscode.window.activeTextEditor!.document.fileName,
            },
            (_) => {
                current_editor = vscode.window.activeTextEditor!;
                return 0;
            }
        );
    }
};

// Gracefully shut down the render client if possible. Shut down the client as
// well.
async function stop_client() {
    console.log("CodeChat Editor extension: stopping client.");
    if (websocket !== undefined) {
        console.log("CodeChat Editor extension: ending connection.");
        websocket?.close();
        websocket = undefined;
    }

    // Shut the timer down after the client is undefined, to ensure it can't be
    // started again by a call to `start_render()`.
    if (idle_timer !== undefined) {
        clearTimeout(idle_timer);
        idle_timer = undefined;
    }

    // Shut down the server.
    try {
        await run_server(["stop"]);
    } catch (err) {
        assert(err instanceof Error);
        console.log(err.message);
    }
}

// Provide an error message in the panel if possible.
function show_error(message: string) {
    if (webview_panel !== undefined) {
        // If the panel was displaying other content, reset it for errors.
        if (
            !webview_panel.webview.html.startsWith("<h1>CodeChat Editor</h1>")
        ) {
            webview_panel.webview.html = "<h1>CodeChat Editor</h1>";
        }
        webview_panel.webview.html += `<p style="white-space: pre-wrap;">${escape(
            message
        )}</p><p>See the <a href="https://github.com/bjones1/CodeChat_Editor" target="_blank" rel="noreferrer noopener">docs</a>.</p>`;
    } else {
        vscode.window.showErrorMessage(
            message + "\nSee https://github.com/bjones1/CodeChat_Editor."
        );
    }
}

// Only render if the window and editor are active, we have a valid render
// client, and the webview is visible.
function can_render(): boolean {
    return (
        vscode.window.activeTextEditor !== undefined &&
        websocket !== undefined &&
        // If rendering in an external browser, the CodeChat panel doesn't need
        // to be visible.
        (codechat_client_location === CodeChatEditorClientLocation.browser ||
            (webview_panel !== undefined && webview_panel.visible))
    );
}

const get_port = (): number => {
    const port = vscode.workspace
        .getConfiguration("CodeChatEditor.Server")
        .get("Port");
    assert(typeof port === "number");
    return port;
};

async function run_server(args: string[]): Promise<string> {
    // Get the command from the VSCode configuration.
    let codechat_editor_server_command = vscode.workspace
        .getConfiguration("CodeChatEditor.Server")
        .get("Command");
    assert(typeof codechat_editor_server_command === "string");

    // If not specified, use the packaged binary.
    if (codechat_editor_server_command === "") {
        const ext = vscode.extensions.getExtension("CodeChat.codechat-editor-client");
        assert(ext !== undefined);
        codechat_editor_server_command = ext.extensionPath + "/server/codechat-editor-server";
    }

    let stdout = "";
    let stderr = "";
    return new Promise((resolve, reject) => {
        const server_process = child_process.spawn(
            codechat_editor_server_command as string,
            ["--port", get_port().toString()].concat(args)
        );
        server_process.on("error", (err: NodeJS.ErrnoException) => {
            const msg =
                err.code === "ENOENT"
                    ? `Error - cannot find the file ${err.path}`
                    : err;
            reject(
                new Error(`While starting the CodeChat Editor Server: ${msg}.`)
            );
        });

        server_process.on("exit", (code, signal) => {
            const exit_str = code ? `code ${code}` : `signal ${signal}`;
            if (code === 0) {
                resolve("");
            } else {
                reject(
                    new Error(
                        `${stdout}\n${stderr}\n\nCodeChat Editor Server exited with ${exit_str}.\n`
                    )
                );
            }
        });

        assert(server_process.stdout !== null);
        server_process.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        assert(server_process.stderr !== null);
        server_process.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
    });
}
