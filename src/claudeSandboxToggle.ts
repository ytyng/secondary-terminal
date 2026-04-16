import * as fs from 'fs';
import * as path from 'path';

const SETTINGS_FILENAME = 'settings.local.json';
const CLAUDE_DIR = '.claude';

export interface ToggleResult {
    enabled: boolean;
}

export function toggleClaudeSandbox(workspaceRoot: string): ToggleResult {
    const claudeDir = path.join(workspaceRoot, CLAUDE_DIR);
    const settingsPath = path.join(claudeDir, SETTINGS_FILENAME);

    if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
    }

    let json: Record<string, any> = {};
    if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf8');
        const parsed = JSON.parse(content);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(`${settingsPath} is not a JSON object`);
        }
        json = parsed;
    }

    const current = json.sandbox?.enabled === true;
    const next = !current;

    if (!json.sandbox || typeof json.sandbox !== 'object' || Array.isArray(json.sandbox)) {
        json.sandbox = {};
    }
    json.sandbox.enabled = next;

    fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2) + '\n');

    return { enabled: next };
}
