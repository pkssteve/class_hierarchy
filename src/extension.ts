// type_hierarchy_extension/src/extension.ts
import * as vscode from 'vscode';
import { LanguageClient ,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';
import * as path from 'path';
import type { ClangdExtension } from '@clangd/vscode-clangd';

const CLANGD_EXTENSION = 'llvm-vs-code-extensions.vscode-clangd';
const CLANGD_API_VERSION = 1;

let languageClient: LanguageClient;

export async function activate(context: vscode.ExtensionContext) {
    // Assume languageClient is initialized and assigned elsewhere, or get it from an extension API
    

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.showHierarchy', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }
            const api = await getClangdAPI();
            if (!api?.languageClient) {
                vscode.window.showErrorMessage('Failed to load Clangd extension API');
                return;
            }

            const textDocument = api.languageClient.code2ProtocolConverter.asTextDocumentIdentifier(editor.document);
            const position = editor.selection.active;
            const params = {textDocument, position, resolve: 5, direction: 2 };

            const item = await api.languageClient.sendRequest('textDocument/typeHierarchy', params);

            if (!item) {
                vscode.window.showInformationMessage('No type hierarchy available');
                return;
            }

            showHierarchyView('Supertypes', item, 'typeHierarchy.expandAllSupers', 'typeHierarchySupertypes', true);
            showHierarchyView('Subtypes', item, 'typeHierarchy.expandAllSubs', 'typeHierarchySubtypes', false);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('typeHierarchy.expandAllSupers', () => {
            vscode.commands.executeCommand('workbench.actions.treeView.typeHierarchySupertypes.expandAll');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('typeHierarchy.expandAllSubs', () => {
            vscode.commands.executeCommand('workbench.actions.treeView.typeHierarchySubtypes.expandAll');
        })
    );
}

function showHierarchyView(
    title: string,
    rootItem: any,
    expandCmd: string,
    viewId: string,
    isSuper: boolean
) {
    const treeDataProvider = new TypeHierarchyProvider(rootItem, isSuper);
    const view = vscode.window.createTreeView(viewId, {
        treeDataProvider,
        showCollapseAll: true
    });

    vscode.commands.executeCommand('setContext', `${viewId}Available`, true);

    const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    button.text = `Expand All ${title}`;
    button.command = expandCmd;
    button.show();
}

class TypeHierarchyProvider implements vscode.TreeDataProvider<TypeItem> {
    constructor(
        private rootItem: any,
        private isSuper: boolean
    ) {}

    getTreeItem(element: TypeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TypeItem): Promise<TypeItem[]> {
        if (!element) {
            return [new TypeItem(this.rootItem, this.isSuper)];
        }

        const method = this.isSuper ? 'typeHierarchy/supertypes' : 'typeHierarchy/subtypes';
        const api = await getClangdAPI();
        if (!api) {
            vscode.window.showErrorMessage('Failed to load Clangd API during hierarchy resolution');
            return [];
        }

        const children = await api.languageClient.sendRequest(method, { item: element.item });
        return (children || []).map((item: any) => new TypeItem(item, this.isSuper));
    }
}

class TypeItem extends vscode.TreeItem {
    constructor(
        public item: any,
        private isSuper: boolean
    ) {
        super(item.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = item.detail || '';
    }
}

async function getClangdAPI(): Promise<any | undefined> {
    const clangdExtension = vscode.extensions.getExtension<ClangdExtension>(CLANGD_EXTENSION);
    let api = undefined;
    if (clangdExtension) {
        api = (await clangdExtension.activate()).getApi(CLANGD_API_VERSION);
        return api;
    }
    return api;
}


// Language Client 시작 함수
function startLanguageClient(context: vscode.ExtensionContext) {
    // 언어 서버 모듈의 경로 (이 예제는 'server/out/server.js'에 서버 구현이 있다고 가정)
    let serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
    let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    let clientOptions: LanguageClientOptions = {
        // 필요에 따라 지원 언어(예: 'java', 'typescript')를 지정
        documentSelector: [{ scheme: 'file', language: 'java' }, { scheme: 'file', language: 'typescript' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
        }
    };

    languageClient = new LanguageClient(
        'typeHierarchyLanguageServer',
        'Type Hierarchy Language Server',
        serverOptions,
        clientOptions
    );
    languageClient.start();
}

export function deactivate() {}