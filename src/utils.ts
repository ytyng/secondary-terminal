import * as vscode from 'vscode';

const MAX_DISPLAY_LINES = 30;

/**
 * エディターの選択箇所に関するコンテクスト文字列を作る
 */
export function createContextTextForSelectedText(editor: vscode.TextEditor): string {
    if (!editor) {
        return '';
    }

    const document = editor.document;
    const selection = editor.selection;
    const fileName = document.fileName;
    const selectedText = document.getText(selection);

    if (selectedText) {
        // 選択されたテキストがある場合：ファイル名、行範囲、選択テキストを返す
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const lineInfo = startLine === endLine ? `L:${startLine}` : `L:${startLine}-${endLine}`;
        let message = `[@${fileName} (${lineInfo})]\n`;
        if (endLine - startLine < MAX_DISPLAY_LINES) {
            message += `\`\`\`\n${selectedText}\n\`\`\`\n`;
        }
        return message;
    } else {
        // 選択されたテキストがない場合：ファイル名のみ返す
        return `[@${fileName}]\n`;
    }
}