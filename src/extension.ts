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
            genHierarchy(context, "all");
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('classHierarchy.showHierarchySupertypes', async () => {
            genHierarchy(context, "super");
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('classHierarchy.showHierarchySubtypes', async () => {
            genHierarchy(context, "sub");
        })
    );
}
async function genHierarchy(context: vscode.ExtensionContext, targetType: string) {
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

    let rootItem = item;
    const highlightName = item.name;
    let isSuper = false;

    if (targetType == 'all') {
        rootItem = findRoot(rootItem);
        isSuper = false;
        
    } else if (targetType == 'super') {
        isSuper = true;
    } else if (targetType == 'sub') {
        isSuper = false;
    }

    const treeDataProvider = new TypeHierarchyProvider(rootItem, isSuper);
    const treeView = vscode.window.createTreeView('classHierarchy', {
        treeDataProvider
    });

    const children = await treeDataProvider.getChildren();
    children[0].item.children
    if (targetType == 'super') {
        children[0].item.children = undefined;
    } else if (targetType == 'sub') {
        children[0].item.parents = undefined;
    }
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

    const mermaidText = await buildMermaidDiagram(rootItem, new Set(), highlightName);
    globalThis.umlPanel.webview.html = renderMermaidWebview(mermaidText, highlightName);
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
        const treeItems = this.isSuper ? this.getSupertypes(element) : this.getSubtypes(element);
        return treeItems;   
    }

    private async getSupertypes(element: TypeItem): Promise<TypeItem[]> {
        const supertypes = await languageClient.sendRequest(
            'typeHierarchy/supertypes',
            { item: element.item }
        );
        return (supertypes || []).map((item: any) => new TypeItem(item, 'super'));
    }

    private async getSubtypes(element: TypeItem): Promise<TypeItem[]> {
        const subtypes = await languageClient.sendRequest(
            'typeHierarchy/subtypes',
            { item: element.item }
        );
        return (subtypes || []).map((item: any) => new TypeItem(item, 'sub'));
    }
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
    for (const supertype of rootItem.parents || []) {
        const superName = supertype?.name ?? '<unknown>';
        const superSanitized = superName;
        lines.push(`class ${superSanitized}`);
        lines.push(`${superSanitized} <|-- ${rootSanitized}`);
        lines.push(await buildMermaidDiagram(supertype, seen, highlightName));
    }

    const subtypes = await languageClient.sendRequest('typeHierarchy/subtypes', { item: rootItem }) as TypeHierarchyItem[] | null;
    for (const subtype of rootItem.children || []) {
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
                .toolbar {
                    margin-bottom: 1rem;
                }
                .download-buttons {
                    position: absolute;
                    top: 8px;
                    right: 12px;
                    display: flex;
                    gap: 8px;
                }
                .download-buttons button {
                    padding: 4px 10px;
                    font-size: 12px;
                    cursor: pointer;
                    border: 1px solid #ccc;
                    background: white;
                    border-radius: 4px;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                }
                .download-buttons button:hover {
                    background: #f0f0f0;
                }
                .mermaid {
                    border: 1px solid #ddd;
                    padding: 1rem;
                    border-radius: 8px;
                    background-color: white;
                }
            </style>
        </head>
        <body>
            <div class="download-buttons">
                    <button onclick="downloadSVG()">SVG</button>
                    <button onclick="downloadPNG()">PNG</button>
            </div>
            <div class="mermaid" id="diagram">
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

                window.downloadSVG = function () {
                    const svg = document.querySelector('#diagram svg');
                    if (!svg) return;
                    const svgData = new XMLSerializer().serializeToString(svg);
                    const blob = new Blob([svgData], { type: 'image/svg+xml' });
                    const url = URL.createObjectURL(blob);

                    const a = document.createElement('a');
                    a.href = url;
                    a.download = generateFilename('svg');
                    a.click();
                    URL.revokeObjectURL(url);
                };

                
                window.downloadPNG = function () {
                    const svg = document.querySelector('#diagram svg');
                    if (!svg) return;
                    const svgData = new XMLSerializer().serializeToString(svg);
                    console.log(svgData)
                    const canvas = document.createElement('canvas');
                    const svgSize = svg.getBoundingClientRect();
                    canvas.width = svgSize.width;
                    canvas.height = svgSize.height;

                    const ctx = canvas.getContext('2d');
                    const img = new Image();
                    img.crossOrigin = 'anonymous';

                    const encodedData = encodeURIComponent(svgData);
                    const url = 'data:image/svg+xml;charset=utf-8,' + encodedData;
                    img.src = url;
                    console.log(url)

                    img.onload = function () {
                        ctx.drawImage(img, 0, 0);
                        URL.revokeObjectURL(url);

                        const pngUrl = canvas.toDataURL('image/png');
                        const a = document.createElement('a');
                        a.href = pngUrl;
                        a.download = generateFilename('png');
                        a.click();
                    };

                    img.src = url;
                };

                // 파일명 생성기: class-diagram_ClassName_YYYY-MM-DD.ext
                function generateFilename(ext) {
                    const today = new Date();
                    const dateStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
                    const className = '${highlightName}'.replace(/[\\/:*?"<>|\\s]/g, '_'); // 안전한 파일명
                    return \`class-diagram_\${className}_\${dateStr}.\${ext}\`;
                }

            </script>
        </body>
        </html>
    `;
}





export function deactivate() { }
