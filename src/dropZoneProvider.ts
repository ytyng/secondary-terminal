import * as vscode from 'vscode';

/**
 * Drop Zone のアイテム
 */
class DropZoneItem extends vscode.TreeItem {
    constructor(label: string, desc?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        if (desc) {
            this.description = desc;
        }
        this.iconPath = new vscode.ThemeIcon('file-media');
    }
}

/**
 * Drop Zone の TreeDataProvider と DragAndDropController
 * ファイルをドロップすると、そのパスを ACE エディターに送信する
 */
export class DropZoneProvider implements
    vscode.TreeDataProvider<DropZoneItem>,
    vscode.TreeDragAndDropController<DropZoneItem> {

    // TreeDragAndDropController の実装
    readonly dropMimeTypes = ['text/uri-list', 'files'];
    readonly dragMimeTypes: string[] = [];

    private _onDidChangeTreeData = new vscode.EventEmitter<DropZoneItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    // ファイルパスを送信するコールバック
    private _onFilesDropped: ((paths: string[]) => void) | null = null;

    constructor() {
        console.log('[DropZone] Provider created');
    }

    /**
     * ファイルドロップ時のコールバックを設定
     */
    setOnFilesDropped(callback: (paths: string[]) => void): void {
        this._onFilesDropped = callback;
    }

    // TreeDataProvider の実装
    getTreeItem(element: DropZoneItem): vscode.TreeItem {
        return element;
    }

    getChildren(_element?: DropZoneItem): Thenable<DropZoneItem[]> {
        // 常に1つのアイテムを表示（ドロップ先の案内）
        return Promise.resolve([
            new DropZoneItem('Drop files here', 'Insert path to editor')
        ]);
    }

    async handleDrop(
        _target: DropZoneItem | undefined,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<void> {
        console.log('[DropZone] handleDrop called');

        const paths: string[] = [];

        // text/uri-list からファイルパスを取得
        const uriListItem = dataTransfer.get('text/uri-list');
        if (uriListItem) {
            const uriListValue = await uriListItem.asString();
            console.log('[DropZone] URI list:', uriListValue);

            const uris = uriListValue
                .split('\n')
                .filter(line => line.trim() && !line.startsWith('#'))
                .map(line => line.trim());

            for (const uriString of uris) {
                try {
                    const uri = vscode.Uri.parse(uriString);
                    if (uri.scheme === 'file') {
                        paths.push(uri.fsPath);
                        console.log('[DropZone] Added path from URI:', uri.fsPath);
                    }
                } catch (e) {
                    console.log('[DropZone] Failed to parse URI:', uriString);
                }
            }
        }

        // DataTransfer から直接ファイルを取得
        for (const [mimeType, item] of dataTransfer) {
            console.log('[DropZone] DataTransfer item:', mimeType);

            const file = item.asFile();
            if (file && file.uri) {
                const filePath = file.uri.fsPath;
                if (!paths.includes(filePath)) {
                    paths.push(filePath);
                    console.log('[DropZone] Added path from file:', filePath);
                }
            }
        }

        if (paths.length > 0) {
            console.log('[DropZone] Dropping paths:', paths);
            if (this._onFilesDropped) {
                this._onFilesDropped(paths);
            }
        } else {
            console.log('[DropZone] No valid file paths found');
        }
    }
}

/**
 * DropZoneProvider を登録
 */
export function registerDropZoneProvider(
    context: vscode.ExtensionContext,
    onFilesDropped: (paths: string[]) => void
): DropZoneProvider {
    const provider = new DropZoneProvider();
    provider.setOnFilesDropped(onFilesDropped);

    // TreeView を登録
    const treeView = vscode.window.createTreeView('secondaryTerminalDropZone', {
        treeDataProvider: provider,
        dragAndDropController: provider,
        canSelectMany: false
    });

    context.subscriptions.push(treeView);

    console.log('[DropZone] Provider registered');

    return provider;
}
