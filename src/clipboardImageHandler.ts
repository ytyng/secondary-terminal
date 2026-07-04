import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ATTACHMENT_DIR = '/tmp/secondary-terminal/attachments';

/**
 * /tmp は全ユーザー共有のため、添付ディレクトリのパス上に
 * シンボリックリンクや他ユーザー所有のディレクトリが存在しないことを確認する。
 * 他ユーザーが先回りしてシンボリックリンクを作り、画像の書き込み先を
 * 自分の読めるディレクトリに誘導する攻撃 (symlink attack) を防ぐ。
 * @throws 安全でないパスコンポーネントが見つかった場合
 */
function ensureAttachmentDirSafe(): void {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    // /tmp 直下から順に各コンポーネントを検証する
    for (const dir of [path.dirname(ATTACHMENT_DIR), ATTACHMENT_DIR]) {
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(dir);
        } catch {
            // 存在しなければこれから自分で作るので安全
            continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()
            || (uid !== undefined && stat.uid !== uid)) {
            throw new Error(`Unsafe attachment directory component: ${dir}`);
        }
    }
}

// 保存した画像を自動削除するまでの期間 (ミリ秒)。/tmp への無制限な蓄積を防ぐ。
const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 保存期間を過ぎた添付ファイルを削除する (ベストエフォート)
 */
function cleanupOldAttachments(): void {
    try {
        const now = Date.now();
        for (const fileName of fs.readdirSync(ATTACHMENT_DIR)) {
            const fullPath = path.join(ATTACHMENT_DIR, fileName);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isFile() && now - stat.mtimeMs > ATTACHMENT_MAX_AGE_MS) {
                    fs.unlinkSync(fullPath);
                }
            } catch (e) {
                // 個別ファイルの削除失敗は無視 (他プロセスとの競合など)
            }
        }
    } catch (e) {
        // ディレクトリ走査の失敗は無視
    }
}

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
        // シンボリックリンク攻撃・他ユーザー所有ディレクトリでないことを確認
        ensureAttachmentDirSafe();

        // ディレクトリが存在しない場合は作成
        // /tmp 配下に置くため、他ユーザーから読めないようパーミッションを絞る
        if (!fs.existsSync(ATTACHMENT_DIR)) {
            fs.mkdirSync(ATTACHMENT_DIR, { recursive: true, mode: 0o700 });
        }
        // 旧バージョンがパーミッション指定なしで作成したディレクトリにも 0700 を適用する
        fs.chmodSync(ATTACHMENT_DIR, 0o700);

        // 古い添付ファイルを掃除する (無制限な蓄積を防ぐ)
        cleanupOldAttachments();

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

        // スクリプトを一時ファイルに書き出して実行。
        // 複数の VSCode ウィンドウ (別プロセス) が同時実行しても衝突しないよう、
        // スクリプトファイル名にも UUID を含める。
        const scriptPath = path.join(ATTACHMENT_DIR, `clipboard_script_${uuid}.applescript`);
        fs.writeFileSync(scriptPath, script);

        // execSync はイベントループ全体をブロックするため、非同期の execFile を使う
        // (macOS の自動化許可ダイアログ待ちで拡張ホストが最大 5 秒固まるのを防ぐ)
        let result: string;
        try {
            const { stdout } = await execFileAsync('osascript', [scriptPath], {
                encoding: 'utf-8',
                timeout: 5000
            });
            result = stdout.trim();
        } finally {
            // 一時スクリプトを削除
            try {
                fs.unlinkSync(scriptPath);
            } catch (e) {
                // 削除失敗は無視
            }
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
