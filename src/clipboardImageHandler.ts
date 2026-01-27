import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ATTACHMENT_DIR = '/tmp/secondary-terminal/attachments';

/**
 * UUID7 を生成（タイムスタンプベース）
 */
function generateUUID7(): string {
    const timestamp = Date.now();
    const timestampHex = timestamp.toString(16).padStart(12, '0');
    const randomBytes = new Uint8Array(10);
    crypto.getRandomValues(randomBytes);
    const hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8, 12)}-7${hex.slice(0, 3)}-${(0x80 | (parseInt(hex.slice(3, 5), 16) & 0x3f)).toString(16)}${hex.slice(5, 7)}-${hex.slice(7, 19)}`;
}

/**
 * macOS でクリップボードから画像を取得してファイルに保存
 * @returns 保存したファイルのパス、または null（画像がない場合）
 */
export async function getImageFromClipboard(): Promise<string | null> {
    if (process.platform !== 'darwin') {
        console.log('[ClipboardImage] Only macOS is supported');
        return null;
    }

    try {
        // ディレクトリが存在しない場合は作成
        if (!fs.existsSync(ATTACHMENT_DIR)) {
            fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
        }

        const uuid = generateUUID7();
        const filePath = path.join(ATTACHMENT_DIR, `${uuid}.png`);

        // AppleScript でクリップボードから画像を取得してファイルに保存
        // シングルクォートをエスケープするため、別の方法でスクリプトを渡す
        const script = `
use framework "AppKit"
use scripting additions

set thePasteboard to current application's NSPasteboard's generalPasteboard()
set theTypes to thePasteboard's types() as list

-- Check for image types
set hasImage to false
repeat with t in theTypes
    if t as text is in {"public.png", "public.tiff", "public.jpeg", "com.apple.pict"} then
        set hasImage to true
        exit repeat
    end if
end repeat

if not hasImage then
    return "NO_IMAGE"
end if

-- Try to get image data
set imageRep to missing value

-- Try PNG first
set pngData to thePasteboard's dataForType:"public.png"
if pngData is not missing value then
    pngData's writeToFile:"${filePath}" atomically:true
    return "OK"
end if

-- Try TIFF (screenshots are often in TIFF format)
set tiffData to thePasteboard's dataForType:"public.tiff"
if tiffData is not missing value then
    set bitmapRep to current application's NSBitmapImageRep's imageRepWithData:tiffData
    if bitmapRep is not missing value then
        set pngData to bitmapRep's representationUsingType:(current application's NSBitmapImageFileTypePNG) |properties|:(missing value)
        pngData's writeToFile:"${filePath}" atomically:true
        return "OK"
    end if
end if

return "FAILED"
`;

        // スクリプトを一時ファイルに書き出して実行
        const scriptPath = path.join(ATTACHMENT_DIR, 'clipboard_script.applescript');
        fs.writeFileSync(scriptPath, script);

        const result = execSync(`osascript "${scriptPath}"`, {
            encoding: 'utf-8',
            timeout: 5000
        }).trim();

        // 一時スクリプトを削除
        try {
            fs.unlinkSync(scriptPath);
        } catch (e) {
            // 削除失敗は無視
        }

        console.log('[ClipboardImage] AppleScript result:', result);

        if (result === 'OK' && fs.existsSync(filePath)) {
            return filePath;
        }

        return null;
    } catch (error) {
        console.error('[ClipboardImage] Failed to get image from clipboard:', error);
        return null;
    }
}
