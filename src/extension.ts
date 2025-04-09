// type_hierarchy_extension/src/extension.ts
import * as vscode from 'vscode';
import type { ClangdExtension } from '@clangd/vscode-clangd';
import type { TypeHierarchyItem } from 'vscode-languageclient';

const CLANGD_EXTENSION = 'llvm-vs-code-extensions.vscode-clangd';
const CLANGD_API_VERSION = 1;
let languageClient: any;

export async function activate(context: vscode.ExtensionContext) {
    const clangdExtension = vscode.extensions.getExtension<ClangdExtension>(CLANGD_EXTENSION);
    if (clangdExtension) {
        const api = (await clangdExtension.activate()).getApi(CLANGD_API_VERSION);
        if (!api.languageClient) {
            vscode.window.showErrorMessage('Clangd language client not found.');
            return;
        }
        languageClient = api.languageClient;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('classHierarchy.showHierarchy', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }

            const textDocument = languageClient.code2ProtocolConverter.asTextDocumentIdentifier(editor.document);
            const position = editor.selection.active;
            const params = { textDocument, position, resolve: 5, direction: 2 };

            

            const item: TypeHierarchyItem = await languageClient.sendRequest('textDocument/typeHierarchy', params);

            if (!item) {
                vscode.window.showInformationMessage('No type hierarchy available');
                return;
            }

            const rootItem = item;

            const treeDataProvider = new UnifiedTypeHierarchyProvider(rootItem);
            const treeView = vscode.window.createTreeView('classHierarchy', {
                treeDataProvider,
                showCollapseAll: true
            });

            const rootNode = new TypeItem(rootItem, 'root');
            treeView.reveal(rootNode, { expand: true, focus: true, select: true });

            const panel = vscode.window.createWebviewPanel(
                'umlDiagram',
                'Class Hierarchy UML Diagram',
                vscode.ViewColumn.Beside,
                { enableScripts: true }
            );
            const mermaidText = await buildMermaidDiagram(rootItem);
            panel.webview.html = renderMermaidWebview(mermaidText);
        })
    );
}

class UnifiedTypeHierarchyProvider implements vscode.TreeDataProvider<TypeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TypeItem | undefined | void> = new vscode.EventEmitter<TypeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<TypeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private rootItem: TypeHierarchyItem) {}

    getTreeItem(element: TypeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TypeItem): Promise<TypeItem[]> {
        if (!element) {
            return [new TypeItem(this.rootItem, 'root')];
        }

        const seen = new Set<string>();
        return await this.fetchHierarchyItems(element.item, seen);
    }

    private async fetchHierarchyItems(item: TypeHierarchyItem, seen: Set<string>): Promise<TypeItem[]> {
        const name = item?.name ?? '<unknown>';
        if (seen.has(name)) return [];
        seen.add(name);

        const supertypes = await languageClient.sendRequest('typeHierarchy/supertypes', { item }) as TypeHierarchyItem[] | null;
        const subtypes = await languageClient.sendRequest('typeHierarchy/subtypes', { item }) as TypeHierarchyItem[] | null;


        const superItems = (supertypes || []).map((entry: any) => new TypeItem(entry, 'super'));
        const subItems = (subtypes || []).map((entry: any) => new TypeItem(entry, 'sub'));

        return [...superItems, ...subItems];
    }
}

class TypeItem extends vscode.TreeItem {
    constructor(
        public item: TypeHierarchyItem,
        private role: 'super' | 'sub' | 'root'
    ) {
        const name = item?.name ?? '<unknown>';
        super(name, vscode.TreeItemCollapsibleState.Expanded);
        this.description = item?.detail || '';
        this.tooltip = `${roleLabel(role)}: ${name}`;
        if (item?.uri && item?.range) {
            this.command = {
                command: 'vscode.open',
                title: 'Go to Definition',
                arguments: [
                    vscode.Uri.parse(item.uri),
                    {
                        selection: new vscode.Range(
                            new vscode.Position(item.range.start.line, item.range.start.character),
                            new vscode.Position(item.range.end.line, item.range.end.character)
                        )
                    }
                ]
            };
        }
    }
}

function roleLabel(role: string): string {
    switch (role) {
        case 'super': return 'Supertype';
        case 'sub': return 'Subtype';
        case 'root': return 'Root';
        default: return '';
    }
}

async function buildMermaidDiagram(rootItem: TypeHierarchyItem, seen = new Set<string>()): Promise<string> {
    const rootName = rootItem?.name ?? '<unknown>';
    if (rootItem==undefined) return '';
    if (seen.has(rootName)) return '';
    seen.add(rootName);

    let lines: string[] = [];
    const supertypes = await languageClient.sendRequest('typeHierarchy/supertypes', { item : rootItem }) as TypeHierarchyItem[] | null;
    for (const supertype of supertypes || []) {
        const superName = supertype?.name ?? '<unknown>';
        lines.push(`${superName} <|-- ${rootName}`);
        lines.push(await buildMermaidDiagram(supertype, seen));
    }

    const subtypes = await languageClient.sendRequest('typeHierarchy/subtypes', { item : rootItem }) as TypeHierarchyItem[] | null;
    for (const subtype of subtypes || []) {
        const subName = subtype?.name ?? '<unknown>';
        lines.push(`${rootName} <|-- ${subName}`);
        lines.push(await buildMermaidDiagram(subtype, seen));
    }

    return lines.join('\n');
}

function renderMermaidWebview(mermaidText: string): string {
    return `
        <html>
        <body>
            <script type="module">
                import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
                mermaid.initialize({ startOnLoad: true });
            </script>
            <div class="mermaid">
                classDiagram\n${mermaidText}
            </div>
        </body>
        </html>
    `;
}

export function deactivate() {}
