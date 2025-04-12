// type_hierarchy_extension/src/extension.ts
import * as vscode from 'vscode';
import type { ClangdExtension } from '@clangd/vscode-clangd';
import * as vscodelc from 'vscode-languageclient/node';
import path = require('path');

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

    context.subscriptions.push(
        vscode.commands.registerCommand('classHierarchy.showSequenceDiagram', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !languageClient) return;

            const position = editor.selection.active;
            const doc = editor.document;
            const uri = doc.uri;

            if (!languageClient?.initializeResult?.capabilities?.callHierarchyProvider) {
                vscode.window.showWarningMessage("LSP server does not support 'textDocument/prepareCallHierarchy'");
                return;
            }

            if (!languageClient?.initializeResult?.capabilities?.implementationProvider) {
                vscode.window.showWarningMessage("LSP server does not support 'textDocument/implementation'");
                return;
            }
            

            const symbols: vscode.DocumentSymbol[] = await vscode.commands.executeCommand(
                'vscode.executeDocumentSymbolProvider', uri
            );

            const funcSymbol = findFunctionSymbolAtPosition(symbols, position);
            if (!funcSymbol) return vscode.window.showErrorMessage('No function found at cursor');

            const rootName = getQualifiedName(funcSymbol, symbols, uri);
            const visited = new Set<string>();
            const docText = doc.getText();
            const callTree = await traceCallsWithLSPViaClient(doc, docText, funcSymbol.range, rootName, 0, 5, visited);

            const mermaidCode = generateMermaidSequence(callTree);
            showMermaidWebview(mermaidCode);
        })
      );
}
5

export type TypeRole = 'super' | 'sub' | 'root';
async function genHierarchy(context: vscode.ExtensionContext, targetType: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }
    if (!languageClient?.initializeResult?.capabilities?.typeHierarchyProvider) {
        vscode.window.showWarningMessage("LSP server does not support 'textDocument/typeHierarchy'");
        return;
    }

    const textDocument = languageClient.code2ProtocolConverter.asTextDocumentIdentifier(editor.document);
    const position = editor.selection.active;
    const params = { textDocument, position, resolve: 5, direction: 2 };

    // 직계 관계
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

    const treeDataProvider = new TypeHierarchyProvider(rootItem, targetType);
    const treeView = vscode.window.createTreeView('classHierarchy', {
        treeDataProvider
    });

    
    let children = await treeDataProvider.getChildren();
    
    if (targetType == 'super') {
        children[0].item.children = undefined;
    } else if (targetType == 'sub') {
        children[0].item.parents = undefined;
    }

    let rootNode = children.find(items => items.item.name === rootItem.name);
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

    const mermaidText = await buildMermaidDiagram(rootItem, targetType, new Set(), highlightName);
    globalThis.umlPanel.webview.html = renderMermaidWebview(mermaidText, highlightName);
}



class TypeItem extends vscode.TreeItem {
    constructor(
        public item: TypeHierarchyItem,
        private role: TypeRole
    ) {
        const name = item?.name ?? '<unknown>';
        super(name, vscode.TreeItemCollapsibleState.Expanded);
        this.description = item?.detail || '';
        this.tooltip = `${roleLabel(role)}: ${name}`;

        const iconMap = {
            root: 'symbol-class',
            super: 'arrow-up',
            sub: 'arrow-down'
        };
        this.iconPath = new vscode.ThemeIcon(iconMap[role] || 'symbol-class');

        if (item?.uri && item?.range) {
            this.command = {
                command: 'vscode.open',
                title: 'Go to Definition',
                arguments: [
                    vscode.Uri.parse(item.uri),
                    new vscode.Range(
                        new vscode.Position(item.range.start.line, item.range.start.character),
                        new vscode.Position(item.range.end.line, item.range.end.character)
                    )
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
        private rootItem: TypeHierarchyItem,
        private mode: string,
    ) {}

    getParent?(element: TypeItem): vscode.ProviderResult<TypeItem> {
        return null;
    }

    getTreeItem(element: TypeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TypeItem): Promise<TypeItem[]> {
        if (!element) {
            return [new TypeItem(this.rootItem, 'root')];
        }

        if (this.mode === 'super') {
            return this.getSupertypes(element);
        }

        return this.getSubtypes(element);
    }

    private async getSupertypes(element: TypeItem): Promise<TypeItem[]> {
        const supertypes = await languageClient.sendRequest('typeHierarchy/supertypes', {
            item: element.item
        });
        return (supertypes || []).map((item: any) => new TypeItem(item, 'super'));
    }

    private async getSubtypes(element: TypeItem): Promise<TypeItem[]> {
        const subtypes = await languageClient.sendRequest('typeHierarchy/subtypes', {
            item: element.item
        });
        return (subtypes || []).map((item: any) => new TypeItem(item, 'sub'));
    }
    private async findTopmostSupertype(item: TypeHierarchyItem): Promise<TypeHierarchyItem> {
        const supertypes = await languageClient.sendRequest('typeHierarchy/supertypes', {
            item
        }) as TypeHierarchyItem[];

        if (supertypes && supertypes.length > 0) {
            return this.findTopmostSupertype(supertypes[0]);
        }

        return item;
    }
    // Get all subtypes of all supertypes of the selected class as TypeItem[]
    public async getSubtypesOfAllSupertypes(): Promise<TypeItem[]> {
        const collected: TypeHierarchyItem[] = [];
        const visited = new Set<string>();

        // Helper to collect all supertypes recursively
        const collectSupertypes = async (item: TypeHierarchyItem) => {
            const supertypes = await languageClient.sendRequest('typeHierarchy/supertypes', { item }) as TypeHierarchyItem[];
            for (const supertype of supertypes || []) {
                if (!visited.has(supertype.name)) {
                    visited.add(supertype.name);
                    collected.push(supertype);
                    await collectSupertypes(supertype);
                }
            }
        };

        // Start from the root item
        await collectSupertypes(this.rootItem);

        // Collect all subtypes of each supertype and wrap in TypeItem
        const allSubtypeItems: TypeItem[] = [];
        for (const supertype of collected) {
            const subtypes = await languageClient.sendRequest('typeHierarchy/subtypes', { item: supertype }) as TypeHierarchyItem[];
            allSubtypeItems.push(...(subtypes || []).map((item: any) => new TypeItem(item, 'sub')));
        }

        return allSubtypeItems;
    }
}

async function buildMermaidDiagram(
    rootItem: TypeHierarchyItem,
    targetType: string,
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

    if(targetType == 'all' || targetType == 'super') {
        const supertypes = await languageClient.sendRequest('typeHierarchy/supertypes', { item: rootItem }) as TypeHierarchyItem[] | null;
        for (const supertype of supertypes || []) {
            const superName = supertype?.name ?? '<unknown>';
            const superSanitized = superName;
            lines.push(`class ${superSanitized}`);
            lines.push(`${superSanitized} <|-- ${rootSanitized}`);
            lines.push(await buildMermaidDiagram(supertype, targetType, seen, highlightName));
        }
    }
    
    if(targetType == 'all' || targetType == 'sub') {
        const subtypes = await languageClient.sendRequest('typeHierarchy/subtypes', { item: rootItem }) as TypeHierarchyItem[] | null;
        for (const subtype of subtypes || []) {
            const subName = subtype?.name ?? '<unknown>';
            const subSanitized = sanitize(subName);
            lines.push(`class ${subSanitized}`);
            lines.push(`${rootSanitized} <|-- ${subSanitized}`);
            lines.push(await buildMermaidDiagram(subtype, targetType, seen, highlightName));
        }
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
interface CallNode {
    name: string;
    children: CallNode[];
  }
  
  function findFunctionSymbolAtPosition(symbols: vscode.DocumentSymbol[], position: vscode.Position): vscode.DocumentSymbol | null {
    for (const symbol of symbols) {
      if (symbol.range.contains(position)) {
        if (symbol.kind === vscode.SymbolKind.Function || symbol.kind === vscode.SymbolKind.Method) {
          return symbol;
        } else if (symbol.children) {
          const found = findFunctionSymbolAtPosition(symbol.children, position);
          if (found) return found;
        }
      }
    }
    return null;
  }
  
  async function traceCallsWithLSPViaClient(
    doc: vscode.TextDocument,
    docText: string,
    range: vscode.Range,
    callerName: string,
    depth: number,
    maxDepth: number,
    visited: Set<string>
  ): Promise<CallNode> {
    if (depth >= maxDepth || visited.has(callerName)) {
      return { name: callerName, children: [] };
    }
    visited.add(callerName);
  
    const children: CallNode[] = [];
    const rangeText = doc.getText(range);
    const matches = Array.from(rangeText.matchAll(/(\w+)\.(\w+)\s*\(|(?<!\.)\b(\w+)\s*\(/g));
    const seen = new Set<string>();
  
    for (const match of matches) {
      const callee = match[2] || match[3];
      if (!callee || seen.has(callee)) continue;
      seen.add(callee);
  
      const index = rangeText.indexOf(callee);
      if (index === -1) continue;
  
      const fullStart = doc.offsetAt(range.start) + index;
      const pos = doc.positionAt(fullStart);

      
  
      const impls = await languageClient.sendRequest('textDocument/implementation', {
        textDocument: { uri: doc.uri.toString() },
        position: { line: pos.line, character: pos.character },
        workDoneToken: undefined,
        partialResultToken: undefined
      });
  
      const locations: vscode.Location[] = [];
  
      if (Array.isArray(impls)) {
        for (const loc of impls) {
          if ('targetUri' in loc) {
            locations.push(new vscode.Location(
              vscode.Uri.parse(loc.targetUri),
              new vscode.Range(
                new vscode.Position(loc.targetSelectionRange.start.line, loc.targetSelectionRange.start.character),
                new vscode.Position(loc.targetSelectionRange.end.line, loc.targetSelectionRange.end.character)
              )
            ));
          } else {
            locations.push(loc);
          }
        }
      } else if (impls) {
        if ('targetUri' in impls) {
          locations.push(new vscode.Location(
            vscode.Uri.parse(impls.targetUri),
            new vscode.Range(
              new vscode.Position(impls.targetSelectionRange.start.line, impls.targetSelectionRange.start.character),
              new vscode.Position(impls.targetSelectionRange.end.line, impls.targetSelectionRange.end.character)
            )
          ));
        } else {
          locations.push(impls);
        }
      }
  
      if (locations.length === 0) continue;
  
      for (const loc of locations) {
        const targetDoc = await vscode.workspace.openTextDocument(loc.uri);
        const targetText = targetDoc.getText();
        const targetSymbols: vscode.DocumentSymbol[] = await vscode.commands.executeCommand(
          'vscode.executeDocumentSymbolProvider', targetDoc.uri
        );
  
        const symbol = findEnclosingSymbol(targetSymbols, new vscode.Range(
          new vscode.Position(loc.range.start.line, loc.range.start.character),
          new vscode.Position(loc.range.end.line, loc.range.end.character)
        ));
        if (!symbol) continue;
  
        const calleeName = getQualifiedName(symbol, targetSymbols, targetDoc.uri);
        const subTree = await traceCallsWithLSPViaClient(targetDoc, targetText, symbol.range, calleeName, depth + 1, maxDepth, visited);
        children.push(subTree);
        break;
      }
    }
  
    return { name: callerName, children };
  }
  
  function findEnclosingSymbol(symbols: vscode.DocumentSymbol[], range: vscode.Range): vscode.DocumentSymbol | null {
    for (const symbol of symbols) {
      if (symbol.range.contains(range)) {
        if (symbol.kind === vscode.SymbolKind.Function || symbol.kind === vscode.SymbolKind.Method) {
          return symbol;
        } else if (symbol.children) {
          const found = findEnclosingSymbol(symbol.children, range);
          if (found) return found;
        }
      }
    }
    return null;
  }
  
  function getQualifiedName(symbol: vscode.DocumentSymbol, allSymbols: vscode.DocumentSymbol[], uri: vscode.Uri): string {
    const scope = findParentScopeName(symbol, allSymbols);
    const container = scope || path.basename(uri.fsPath).replace(/\..*$/, '');
    return `${container}::${symbol.name}`;
  }
  
  function findParentScopeName(symbol: vscode.DocumentSymbol, allSymbols: vscode.DocumentSymbol[]): string | undefined {
    let result: string | undefined = undefined;
  
    function findParent(symbols: vscode.DocumentSymbol[], child: vscode.DocumentSymbol): boolean {
      for (const symbol of symbols) {
        if (symbol.children?.includes(child)) {
          if (
            symbol.kind === vscode.SymbolKind.Class ||
            symbol.kind === vscode.SymbolKind.Struct ||
            symbol.kind === vscode.SymbolKind.Namespace
          ) {
            result = symbol.name;
            return true;
          } else {
            return findParent(symbol.children || [], child);
          }
        } else if (symbol.children && findParent(symbol.children, child)) {
          return true;
        }
      }
      return false;
    }
  
    findParent(allSymbols, symbol);
    return result;
  }

  function generateMermaidSequence(root: CallNode): string {
    const lines: string[] = ['sequenceDiagram'];
    const participants = new Set<string>();
    const edges: [string, string][] = [];
    const seenEdges = new Set<string>();
  
    function dfs(node: CallNode) {
      participants.add(node.name);
      for (const child of node.children) {
        const edgeKey = `${node.name}->>${child.name}`;
        if (!seenEdges.has(edgeKey)) {
          edges.push([node.name, child.name]);
          seenEdges.add(edgeKey);
        }
        dfs(child);
      }
    }
  
    dfs(root);
  
    for (const name of participants) {
      lines.push(`    participant ${name}`);
    }
    for (const [from, to] of edges) {
      lines.push(`    ${from}->>${to}: call`);
    }
    return lines.join('\n');
  }
  
  function showMermaidWebview(mermaidCode: string) {
    const panel = vscode.window.createWebviewPanel(
      'sequenceDiagram',
      'C++ Call Sequence Diagram',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
  
    panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <script type="module">
          import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
          mermaid.initialize({ startOnLoad: true });
        </script>
      </head>
      <body>
        <div class="mermaid">
          ${mermaidCode}
        </div>
      </body>
      </html>
    `;
  }
export function deactivate() { }
