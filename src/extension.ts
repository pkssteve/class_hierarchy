// type_hierarchy_extension/src/extension.ts
import * as vscode from 'vscode';
import type { ClangdExtension } from '@clangd/vscode-clangd';
import * as vscodelc from 'vscode-languageclient/node';

const CLANGD_EXTENSION = 'llvm-vs-code-extensions.vscode-clangd';
const CLANGD_API_VERSION = 1;
let languageClient: any;
declare global {
    var umlPanel: vscode.WebviewPanel | undefined;
}
interface TypeHierarchyItem {
    name: string;
    detail?: string;
    kind: vscodelc.SymbolKind;
    deprecated?: boolean;
    uri: string;
    range: vscodelc.Range;
    selectionRange: vscodelc.Range;
    parents?: TypeHierarchyItem[];
    children?: TypeHierarchyItem[];
    data?: any;
}
function findRoot(node: TypeHierarchyItem): TypeHierarchyItem {
    let current = node;
    while (current.parents && current.parents.length > 0) {
        // 여기선 첫 번째 부모만 따라감 (복수 부모가 있는 경우 커스터마이징 가능)
        current = current.parents[0];
    }
    return current;
}
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

            const treeDataProvider = new TypeHierarchyProvider(findRoot(rootItem), false);
            const treeView = vscode.window.createTreeView('classHierarchy', {
                treeDataProvider,
                showCollapseAll: true
            });

            const children = await treeDataProvider.getChildren();
            const rootNode = children.find(item => item.item.name === rootItem.name);
            if (rootNode) {
                treeView.reveal(rootNode, { expand: true, focus: true, select: true });
            }
            if (!globalThis.umlPanel) {
                globalThis.umlPanel = vscode.window.createWebviewPanel(
                    'umlDiagram',
                    'Class Hierarchy UML Diagram',
                    vscode.ViewColumn.Beside,
                    { enableScripts: true }
                );
                globalThis.umlPanel.onDidDispose(() => {
                    globalThis.umlPanel = undefined;
                }, null, context.subscriptions);
            } else {
                globalThis.umlPanel.reveal(vscode.ViewColumn.Beside);
            }

            const mermaidText = await buildMermaidDiagram(rootItem, new Set(), rootItem.name);
            globalThis.umlPanel.webview.html = renderMermaidWebview(mermaidText, rootItem.name);
            // showHierarchyView('Subtypes', findRoot(item), 'typeHierarchy.expandAllSubs', 'classHierarchyText', true);
        })
    );
}

class UnifiedTypeHierarchyProvider implements vscode.TreeDataProvider<TypeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TypeItem | undefined | void> = new vscode.EventEmitter<TypeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<TypeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private rootItem: TypeHierarchyItem) { }

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

        const iconMap = {
            root: 'symbol-class.svg',
            super: 'arrow-up.svg',
            sub: 'arrow-down.svg'
        };
        this.iconPath = new vscode.ThemeIcon(iconMap[role] || 'symbol-class');
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
class TypeHierarchyProvider implements vscode.TreeDataProvider<TypeItem> {
    constructor(
        private rootItem: any,
        private isSuper: boolean
    ) { }
    getParent?(element: TypeItem): vscode.ProviderResult<TypeItem> {
        return null;
    }
    getTreeItem(element: TypeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TypeItem): Promise<TypeItem[]> {
        if (!element) {
            return [new TypeItem(this.rootItem, this.isSuper ? 'super' : 'sub')];
        }

        const method = this.isSuper ? 'typeHierarchy/supertypes' : 'typeHierarchy/subtypes';

        const children = await languageClient.sendRequest(method, { item: element.item });
        return (children || []).map((item: any) => new TypeItem(item, this.isSuper ? 'super' : 'sub'));
    }
}
function showHierarchyView(
    title: string,
    rootItem: any,
    expandCmd: string,
    viewId: string,
    isSuper: boolean
) {
    const treeDataProvider = new UnifiedTypeHierarchyProvider(rootItem);
    const view = vscode.window.createTreeView(viewId, {
        treeDataProvider,
        showCollapseAll: true
    });

    vscode.commands.executeCommand('setContext', `${viewId}`, true);

    const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    button.text = `Expand All ${title}`;
    button.command = expandCmd;
    button.show();
}
async function buildTextHierarchy(item: TypeHierarchyItem, indent = 0, seen = new Set<string>()): Promise<string> {
    const name = item?.name ?? '<unknown>';
    if (seen.has(name)) return '';
    seen.add(name);

    const prefix = '  '.repeat(indent) + '- ' + name;
    let lines = [prefix];

    const supertypes = await languageClient.sendRequest('typeHierarchy/supertypes', { item }) as TypeHierarchyItem[] | null;
    for (const supertype of supertypes || []) {
        lines.push(await buildTextHierarchy(supertype, indent + 1, seen));
    }

    const subtypes = await languageClient.sendRequest('typeHierarchy/subtypes', { item }) as TypeHierarchyItem[] | null;
    for (const subtype of subtypes || []) {
        lines.push(await buildTextHierarchy(subtype, indent + 1, seen));
    }

    return lines.join('\n');
}

async function buildMermaidDiagram(
    rootItem: TypeHierarchyItem,
    seen = new Set<string>(),
    highlightName = rootItem?.name ?? '<unknown>'
): Promise<string> {
    const rootName = rootItem?.name ?? '<unknown>';
    if (!rootItem || seen.has(rootName)) return '';
    seen.add(rootName);

    const sanitize = (name: string) => name.replace(/[^\w]/g, '-');
    const rootSanitized = rootName;

    let lines: string[] = [];
    lines.push(`class ${rootName}`);

    const supertypes = await languageClient.sendRequest('typeHierarchy/supertypes', { item: rootItem }) as TypeHierarchyItem[] | null;
    for (const supertype of supertypes || []) {
        const superName = supertype?.name ?? '<unknown>';
        const superSanitized = superName;
        lines.push(`class ${superSanitized}`);
        lines.push(`${superSanitized} <|-- ${rootSanitized}`);
        lines.push(await buildMermaidDiagram(supertype, seen, highlightName));
    }

    const subtypes = await languageClient.sendRequest('typeHierarchy/subtypes', { item: rootItem }) as TypeHierarchyItem[] | null;
    for (const subtype of subtypes || []) {
        const subName = subtype?.name ?? '<unknown>';
        const subSanitized = sanitize(subName);
        lines.push(`class ${subSanitized}`);
        lines.push(`${rootSanitized} <|-- ${subSanitized}`);
        lines.push(await buildMermaidDiagram(subtype, seen, highlightName));
    }

    return lines.join('\n');
}
function renderMermaidWebview(mermaidText: string, highlightName: string): string {
    return `
        <html>
        <head>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                }
            </style>
        </head>
        <body>
            <div class="mermaid">
classDiagram
${mermaidText}
            </div>

            <script type="module">
                import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
                mermaid.initialize({ startOnLoad: true, theme: 'neutral' });

                setTimeout(() => {
                    const nodes = document.querySelectorAll('g.node');

                    for (const node of nodes) {
                        const labels = node.querySelectorAll('span.nodeLabel');
                        for (const label of labels) {
                            const text = label.textContent.trim();
                            console.log('[🔍 검사 중]', text);

                            if (text === '${highlightName}') {
                                console.log('[✅ 매칭됨]', text);

                                const rect = node.querySelector('rect');
                                if (rect) {
                                    // ✅ 스타일 직접 지정
                                    rect.style.fill = 'lightyellow';
                                    rect.style.stroke = 'darkorange';
                                    rect.style.strokeWidth = '3px';
                                }

                                const lines = node.querySelectorAll('line');
                                for (const line of lines) {
                                    line.style.stroke = 'darkorange';
                                    line.style.strokeWidth = '2px';
                                }

                                break;
                            }
                        }
                    }
                }, 500);

            </script>
        </body>
        </html>
    `;
}





export function deactivate() { }
