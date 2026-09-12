import * as vscode from 'vscode';

/**
 * 復元に対応する CLI エージェント。
 * `resumeCommand` はそのエージェント自身の「直前のセッションを継続する」コマンドで、
 * セッション ID の管理はエージェント側に任せる (拡張側でセッションファイルの
 * 場所や命名規則に依存しないため、CLI の内部構造が変わっても壊れない)。
 *
 * pty-shell.py は gemini / copilot も検出するが、こちらから復元できるのは
 * 「直前のセッションを継続する」コマンドを持つこの 2 つだけ。
 */
const AGENTS = {
    claude: {
        label: 'Claude Code',
        // 「カレントディレクトリの直近の会話を継続する」
        resumeCommand: 'claude --continue',
    },
    codex: {
        label: 'Codex',
        // 「最後に記録されたセッションを継続する」(引数なしだとピッカーが出る)
        resumeCommand: 'codex resume --last',
    },
} as const;

export type AgentKind = keyof typeof AGENTS;

interface LaunchRecord {
    agent: AgentKind;
    /** そのエージェントを最後に使っていた時刻 (epoch ms) */
    at: number;
}

/**
 * 記録は**ワークスペースごとに独立したキー**へ書く。1 つのオブジェクトにまとめると、
 * 同じプロファイルで開いた別ウィンドウが同じスナップショットを読んで丸ごと書き戻し、
 * 相手のワークスペースの記録を消してしまう (拡張ホストはウィンドウごとに別プロセスなので、
 * こちら側の直列化では防げない)。
 */
const STATE_KEY_PREFIX = 'secondaryTerminal.lastAgentLaunch:';

/** これより古い記録は「前回のセッション」とみなさない */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** OSC シーケンスがチャンク境界で切れた時に持ち越す末尾の上限 */
const MAX_PENDING_OUTPUT = 4096;

/** pty-shell.py がステータス通知に使う OSC 777 シーケンス */
const STATUS_SEQUENCE = /\x1b\]777;([^\x07]*)\x07/g;
const STATUS_PREFIX = '\x1b]777;';

interface CliAgentStatus {
    active?: boolean;
    agent_type?: string | null;
}

/**
 * OSC 777 の `cli_agent_status` 1 件の解釈結果。
 * `active` なのに `agent` が無いのは、復元コマンドを持たないエージェント
 * (gemini / copilot) が動いている場合。
 */
export interface AgentStatus {
    active: boolean;
    agent?: AgentKind;
}

/**
 * 「前回このワークスペースで使っていた CLI エージェント」を覚えておき、
 * 次に空のターミナルが立ち上がったときにセッションの復元を提案する。
 *
 * 検知には pty-shell.py が既に出している CLI エージェントの稼働状態
 * (OSC 777 の `cli_agent_status`。シェルの子孫プロセスを見て判定している) を使う。
 * 入力行を覗いてコマンド名を拾う方式だと、履歴から呼び出した (↑ キー) 場合や
 * 補完で確定した場合に文字列がこちらを通らないため、最も普通の起動方法を
 * 取りこぼす。
 *
 * エージェント側のセッションファイル (`~/.claude/projects/` 等) は読みに行かない。
 * 保存場所も命名規則も CLI の内部実装で、拡張から追随し続けるのが現実的でないため。
 */
export class AgentSessionRestore {
    /** OSC シーケンスがチャンク境界で分断された場合の持ち越し (タブごと) */
    private readonly pendingOutputs: Map<string, string> = new Map();

    /**
     * 今そのタブで動いている復元対象エージェント (タブごと)。
     * プロセスが死んだときに「何が動いたまま死んだか」を知るために持つ。
     */
    private readonly activeAgents: Map<string, AgentKind> = new Map();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.pruneStaleRecords();
    }

    /**
     * シェルの出力を覗いて、CLI エージェントが動き出したことを記録する。
     * `tabKey` は OSC の持ち越しをタブごとに分けるためのキー、`workspaceKey` は
     * 記録のキー (取り出す側と同じ値を渡すこと)。
     */
    public observeOutput(tabKey: string, workspaceKey: string, output: string): void {
        if (!output) {
            return;
        }
        const combined = (this.pendingOutputs.get(tabKey) ?? '') + output;

        STATUS_SEQUENCE.lastIndex = 0;
        let match: RegExpExecArray | null;
        let consumedUntil = 0;
        while ((match = STATUS_SEQUENCE.exec(combined)) !== null) {
            consumedUntil = match.index + match[0].length;
            this.handleStatusPayload(tabKey, workspaceKey, match[1] ?? '');
        }

        // 終端 (BEL) が来ていないシーケンスの途中だけを次回に持ち越す。
        // 通常の出力まで溜め込むと、長い出力で無駄にメモリを使う。
        // ESC から後ろを見るのは、プレフィックス自体がチャンク境界で割れた場合
        // (末尾が "\x1b]77" 等) も拾うため
        const tail = combined.slice(consumedUntil);
        const escIndex = tail.lastIndexOf('\x1b');
        const candidate = escIndex === -1 ? '' : tail.slice(escIndex);
        const pending = isStatusSequenceStart(candidate) ? candidate : '';
        if (pending.length > MAX_PENDING_OUTPUT) {
            // ここまで長いのは OSC の取りこぼし (BEL が来なかった) なので捨てる
            this.pendingOutputs.delete(tabKey);
            return;
        }
        if (pending) {
            this.pendingOutputs.set(tabKey, pending);
        } else {
            this.pendingOutputs.delete(tabKey);
        }
    }

    /** タブを閉じたときに持ち越しと稼働状態を捨てる */
    public forgetTab(tabKey: string): void {
        this.pendingOutputs.delete(tabKey);
        this.activeAgents.delete(tabKey);
    }

    /** そのタブで今動いている復元対象エージェント (無ければ undefined) */
    public getActiveAgent(tabKey: string): AgentKind | undefined {
        return this.activeAgents.get(tabKey);
    }

    /**
     * どこかのタブでそのエージェントが動いているか。
     * 死んだタブのぶんを復元提案するとき、同じエージェントが別タブで生きていないかの
     * 確認に使う (生きているセッションへ二重に接続しないため)。
     */
    public hasActiveAgent(agent: AgentKind): boolean {
        for (const active of this.activeAgents.values()) {
            if (active === agent) {
                return true;
            }
        }
        return false;
    }

    /**
     * そのエージェントを「今このワークスペースで使っている」と記録する。
     * 復元コマンドを送った直後にも呼ぶ (復元して使い続けているのに、最初の
     * 起動から 14 日で候補が失効してしまうのを防ぐ)。
     */
    public recordAgentUse(workspaceKey: string, agent: AgentKind): void {
        // 自分のワークスペースのキーだけを丸ごと置き換える。read-modify-write が
        // 無いので、同時に書いても他のワークスペースの記録は巻き込まれない
        const record: LaunchRecord = { agent, at: Date.now() };
        void this.context.globalState.update(stateKeyFor(workspaceKey), record);
    }

    /**
     * 復元を提案する対象。記録が無い / 古すぎる場合は undefined。
     *
     * ウィンドウ起動時に 1 度だけ読むこと。後から読み直すと、同じウィンドウで
     * さっき起動したばかりのエージェントを「前回のセッション」として提案し、
     * 別タブで動いているセッションに二重に接続しかねない。
     */
    public getRestoreCandidate(workspaceKey: string, now: number = Date.now()): AgentKind | undefined {
        const record = this.readRecord(workspaceKey);
        if (!record) {
            return undefined;
        }
        // 未来の時刻 (時計のずれ) は古い記録と同じく無視する
        const age = now - record.at;
        if (age < 0 || age > MAX_AGE_MS) {
            return undefined;
        }
        return record.agent;
    }

    public static label(agent: AgentKind): string {
        return AGENTS[agent].label;
    }

    /** そのエージェントの「直前のセッションを継続する」コマンド (改行なし) */
    public static resumeCommand(agent: AgentKind): string {
        return AGENTS[agent].resumeCommand;
    }

    private handleStatusPayload(tabKey: string, workspaceKey: string, payload: string): void {
        const status = parseAgentStatus(payload);
        if (!status) {
            return;
        }
        // 復元対象でないエージェント (gemini 等) や停止の通知では、そのタブの
        // 稼働状態を消す。消さないと、既に終わったエージェントを「動いたまま死んだ」
        // と誤認して復元を提案してしまう
        if (!status.active || !status.agent) {
            this.activeAgents.delete(tabKey);
            return;
        }
        this.activeAgents.set(tabKey, status.agent);
        this.recordAgentUse(workspaceKey, status.agent);
    }

    private readRecord(workspaceKey: string): LaunchRecord | undefined {
        const stored = this.context.globalState.get<LaunchRecord>(stateKeyFor(workspaceKey));
        // 壊れた値が入っていても落ちないようにする (旧バージョンの形式など)
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            return undefined;
        }
        if (typeof stored.at !== 'number' || typeof stored.agent !== 'string' || !(stored.agent in AGENTS)) {
            return undefined;
        }
        return { agent: stored.agent as AgentKind, at: stored.at };
    }

    /**
     * 失効した記録をストレージから消す。ワークスペースごとにキーを分けたぶん、
     * 消さないと使わなくなったディレクトリの分だけキーが増え続ける。
     *
     * 消す直前に読み直すのは、別ウィンドウがそのキーを書き直していた場合に
     * 消さないため。拡張ホストはウィンドウごとに別プロセスなので、これは
     * アトミックな保証にはならない (Memento に compare-and-delete が無い) が、
     * 競合する窓を実質ゼロに縮められる。**残る競合の影響は「次回の復元提案が
     * 1 回出ない」だけ**で、ユーザーのデータは失われない。
     */
    private pruneStaleRecords(): void {
        const staleKeys = this.context.globalState.keys().filter((key) => {
            if (!key.startsWith(STATE_KEY_PREFIX)) {
                return false;
            }
            return this.isStale(key);
        });
        for (const key of staleKeys) {
            // keys() の走査中に別ウィンドウが書き直しているかもしれないので読み直す
            if (this.isStale(key)) {
                void this.context.globalState.update(key, undefined);
            }
        }
    }

    private isStale(key: string): boolean {
        const stored = this.context.globalState.get<LaunchRecord>(key);
        const at = stored && typeof stored.at === 'number' ? stored.at : undefined;
        return at === undefined || Date.now() - at > MAX_AGE_MS;
    }
}

/** ワークスペース 1 つ分の記録を置く globalState のキー */
function stateKeyFor(workspaceKey: string): string {
    return `${STATE_KEY_PREFIX}${workspaceKey}`;
}

/**
 * その文字列が `ESC]777;` の (途中まででも) 始まりなら true。
 * チャンク境界で割れたシーケンスだけを持ち越し、他のエスケープシーケンス
 * (色指定など、出力の大半) は捨てるために使う。
 */
function isStatusSequenceStart(text: string): boolean {
    if (!text) {
        return false;
    }
    return text.length >= STATUS_PREFIX.length
        ? text.startsWith(STATUS_PREFIX)
        : STATUS_PREFIX.startsWith(text);
}

/**
 * pty-shell.py の OSC 777 ペイロードから、CLI エージェントの稼働状態を取り出す。
 *
 * 同じ OSC 777 はアプリからの通知 (`notify;<title>;<body>`) やフォアグラウンド
 * プロセス名の通知にも使われるので、JSON として読めないものと種別違いは黙って捨てる。
 *
 * **信頼境界**: ターミナル内で動く任意のプロセスも同じ OSC を出力できるため、
 * これが pty-shell.py 由来かどうかは区別できない。偽装されて困る情報ではない
 * (記録できるのは「claude / codex を使っていた」という事実だけで、そこから実行される
 * コマンドは固定文字列、しかも実行前にユーザーの確認が入る) ので、そのまま扱う。
 */
export function parseAgentStatus(payload: string): AgentStatus | undefined {
    if (!payload.startsWith('{')) {
        return undefined;
    }
    let message: { type?: string; data?: CliAgentStatus };
    try {
        message = JSON.parse(payload);
    } catch {
        return undefined;
    }
    if (message?.type !== 'cli_agent_status') {
        return undefined;
    }
    if (!message.data?.active) {
        return { active: false };
    }
    const agentType = message.data.agent_type;
    // gemini / copilot も検出されるが、復元コマンドを持つものだけを対象にする
    if (agentType === 'claude' || agentType === 'codex') {
        return { active: true, agent: agentType };
    }
    return { active: true };
}
