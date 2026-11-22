# dsh-web-inspect 输入框插入 API 调研（input-api / task-1）

> 依据：只读静态源码（`.d.ts` + `lib/client.js`），未在运行中的 GUI 实测（http://127.0.0.1:3080 未认证返回 401，由 install-e2e 负责）。
> `$INST = /Users/care/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`
> 结论先行：**主路径 = 会话作用域 slot 组件里的 `props.inputActions.insertText(block, span)`，`span = inputActions.captureInsertion()`；不发送、保留已有草稿与引用 chip、多行/``` 围栏原样保留。** 兜底 = `ctx.sessions.binding(sessionId)` → `ctx.conversation.input.requestDraftInitialization(binding, {prompt, whenDraftExists:"append"})`；再兜底 = `setDraft`（有损，仅限无 chip 草稿）→ 剪贴板。会话由 slot 的 standard props `props.sessionId` 给出（右侧栏 tab 所属会话），无需另找"当前会话"服务。

---

## 0. 三个必须更正的前提（Lead 消息里的 1/2/3）

1. **`conversation.input.for(actx)` 确实返回 `SessionInputShell` 实例**（不是裁剪 facade）：`InputHub.for` 末尾 `return this.shellFor(binding)`（`$INST/dsh-client-ui-conversation/lib/client.js:16126-16134`），`shellFor` 里 `new SessionInputShell({...})` 并缓存（同文件 `:16144` 起）。
2. **`appendDraft` 不在 `SessionInputShell` 上**，它是 `DraftEditor` 的内部方法（`client.js:15051-15065`），全文件只有两处出现：定义 `:15051`、`SessionInputShell.requestDraftInitialization` 内部调用 `this.draftEditor.appendDraft(options.prompt)`（`:15545`）。所以 `input.appendDraft(...)` 在运行时是 `undefined`（当前 `lib/client.js:480` 的分支永远走不到，会落到 `setDraft`）。**要追加语义请用契约方法 `requestDraftInitialization(..., {whenDraftExists:"append"})`**（`SessionInputResolver` 的公开方法，`input.d.ts:206-217`）。
3. **`inputActions` 不是"仅 conversation 区域 slot"可取**：conversation 包通过 `ctx.uiSession.provide({hooks:["conversation","input"], props:["inputActions"], resolve: binding => ({...props:{inputActions: shell.actions}})})`（`client.js:22775-22794`）注册的是**会话作用域标准 props**；`UiSession.materialize(binding)` 会合并所有 descriptor 的 props（`$INST/dsh-client-ui-session/lib/client.js:1028-1047`），并且 `apply` 里 `ctx.slots.installScope("session", service.adapter)`（同文件 `:1130`）把这份 props 集合注入**所有 `scope:"session"` 的 slot**。我们的 `sidebar.right.tab.document.actions` 正是 `{kind:"list", scope:"session"}`（`$INST/dsh-client-ui-sidebar-documentpreview/lib/client.js:8032-8035`），因此**组件 props 里既有 `sessionId` 也有 `inputActions`**；cordis-client-runner 的 slot 目录也把 `inputActions`/`sessionId` 列进该 slot 的 `standardProps`（`$INST/dsh-cordis-client-runner/lib/client.js:6535-6590`）。唯一例外：`session-maybe` 作用域的 slot 里才是 `InputActions | undefined`（`contract/slots.d.ts:489-497`）。

---

## 1. 客户端插件如何取得 ctx / conversation 服务

模块形状（官方 `dsh-message-quotes`、`dsh-experimental-client-ui-voice-input`、本地先例 `/Users/care/Projects/dsh-phone/dsh-one` 都是这个形状，build-free、无打包）：

```js
window.__ModuleLoader__.load({
  id: "dsh-web-inspect",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    // ...插件代码...
    exports.apply = apply;
    exports.inject = inject; // cordis 服务名数组
    exports.name = "dsh-web-inspect";
    return module.exports;
  },
});
```

- `exports.inject` 是 **cordis 服务名**（不是包名），apply 前等待这些服务就绪。官方例子：`dsh-message-quotes/lib/client.js` 尾部 `const inject = ["slots","locale","sessions","uiConversation"]`；conversation 包自带的 queue-dock 插件 `["slots","conversation","sessions","uiConversation"]`（`client.js:19930-19960`）。我们的 `lib/client.js` 现在用 `["slots","locale","sessions","documentPreviews"]` 是对的。
- `ctx` 是插件 apply 的根上下文；Context 类型被 conversation 包增强：`conversation: IConversation`、`uiConversation: UiConversation`（`$INST/dsh-client-ui-conversation/lib/types/client/index.d.ts:105-112`）。服务访问方式在真实代码里两种都有：
  - 直接属性：`ctx.slots` / `ctx.locale` / `ctx.sessions` / `ctx.conversation`（`ctx.conversation` 由 Service tracker 代理，属性读取时按调用方上下文重绑，`service.d.ts:1-10`）。
  - `ctx.get("sessions")` / `actx.get("conversation")`（`client.js:19945`）、`ctx.inject(["inputTriggers"], cb)`（`client.js:16213`）——用于可选/惰性服务。
- `ctx.conversation` 是 root singleton（`ConversationController extends Service`，`service.d.ts:26-57,58-...`），`ctx.conversation.input` 是 `SessionInputResolver`（InputHub），按 **session ctx / binding** 解析，不是"当前会话"全局单例。
- **但是**：插在右侧栏 slot 里的按钮/正文组件根本不需要查服务——`inputActions`、`sessionId` 是渲染 props（§6）。只有兜底/无 slot 上下文时才走 `ctx.sessions` + `ctx.conversation`。

---

## 2. 逐字签名（`.d.ts` 原文，附 file:line）

`$INST/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts`

```ts
// L82-86
interface InsertTextRequest {
    readonly text: string;
    readonly span: TokenSpan;
    readonly continue?: boolean;
}

// L150-155（session 作用域事件，见 §3.5）
interface Events {
    'slash/input-insert-text'(request: InsertTextRequest): true | undefined; // @mode bail
    ...
}

// L158-166
interface InputTarget {
    beginCommand(claim: CommandClaim, span: TokenSpan): boolean;
    insertReference(ref: ReferenceInsert, span: TokenSpan): boolean;
}

// L167-204（per-session facade 的公开契约：注意【没有 insertText】）
interface SessionInput extends InputTarget {
    insertQuote(text: string): boolean;
    setDraft(text: string): void;
    addAttachments(ids: readonly DraftAttachmentId[]): boolean;
    removeAttachment(id: DraftAttachmentId): boolean;
    pruneAttachments(available: readonly DraftAttachmentId[]): void;
    submit(mode?: InputSubmitMode, source?: 'click' | 'enter'): void;
    notify(level: 'info' | 'error', text: string): void;
    focus(): void;
    readonly state: SnapshotStore<InputState>;
}

// L206-217
interface SessionInputResolver {
    for(actx: Context): SessionInput;
    requestDraftInitialization(binding: SessionBinding, options: DraftInitializationOptions): DraftInitializationResult;
}

// L219-236
interface DraftInitializationOptions {
    readonly prompt?: string;
    readonly clearPreviousDraft?: boolean;
    readonly whenDraftExists?: 'replace' | 'append' | 'keep';
}
type DraftInitializationResult = 'applied' | 'preserved' | 'blocked';

// L239-263（slot 组件拿到的动作面）
interface InputActions {
    insertQuote(text: string): boolean;
    /** @returns a revision-guarded copy of the current editor selection */
    captureInsertion(): TokenSpan;
    /**
     * Insert asynchronous text without replacing subsequent edits or reference chips.
     * @param text - plain text to insert in one undo step.
     * @param span - captured selection and draft revision.
     * @returns false when the draft changed or submission locked the editor.
     */
    insertText(text: string, span: TokenSpan): boolean;
    /** Replace the whole draft with plain text, removing inline reference chips. */
    setDraft(text: string): void;
    persistDraft(): void;
    addAttachments(ids: readonly DraftAttachmentId[]): boolean;
    removeAttachment(id: DraftAttachmentId): void;
    pruneAttachments(available: readonly DraftAttachmentId[]): void;
    submit(): void;
}

// L273-298（InputState，useInput 选择器）
interface InputState {
    readonly draft: string;          // clipboard-text projection，含换行
    readonly attachmentIds: readonly DraftAttachmentId[];
    readonly draftRev: number;       // 单调递增，TokenSpan 的 CAS 版本
    readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' | 'sending';
    readonly claim?: CommandClaim;
    readonly occurrences: readonly Occurrence[];
    readonly queue: ...;
}
```

`$INST/dsh-client-ui-conversation/lib/types/client/contract/draft-editor.d.ts`

```ts
// L6-10
interface TokenSpan {
    readonly start: number;
    readonly end: number;
    readonly draftRev: number;
}
// L12-18
interface ReferenceInsert {
    readonly source: string;
    readonly ref: string;
    readonly label: string;
    readonly appearance?: 'session' | 'file' | 'folder';
    readonly clipboardText: string;
}
// L22-27
interface DraftQuote {
    readonly offset: number;
    readonly length: number;
    readonly text: string;
}
```

标准 props（session 作用域）`$INST/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:477-497`：

```ts
interface GlobalStandardProps { useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>; }
interface SessionStandardProps {
    useConversation: UseConversation;
    useInput: SnapshotSelectorHook<InputState>;
    inputActions: InputActions;
}
interface SessionMaybeStandardProps {
    useConversation: MaybeSnapshotSelectorHook<ConversationSnapshot>;
    useInput: MaybeSnapshotSelectorHook<InputState>;
    inputActions: InputActions | undefined;
}
```

`$INST/dsh-client-ui-session/lib/types/client/index.d.ts:72-95` 再给 session 作用域加：`useSession: SessionSnapshotSelector`、`sessionId: SessionId`、`useProjection`、`useAccess`（`session-maybe` 下为可选/undefined）。

---

## 3. 语义（实现层逐条核对）

### 3.1 `insertText(text, span)` —— 主路径

- **插入位置 = 捕获的选区**。`captureInsertion()` 实现：`{...this.caretSpan(), draftRev: this.rev}`（`client.js:15370-15373`）；`caretSpan` 的规则是"有选区用选区；无选区/失焦时折叠在文档末尾"：`if (this.projection.selection !== null) return this.projection.selection; const at = this.projection.detectText.length; return {start:at,end:at}`（editor `:15092-15098`，shell 转发 `:15682-15686`）。
- **替换而非追加**：`$replaceDetectSpanWithText` 用 `selectSpan($composerLayout(), span)` 还原选区后 `selection.insertText(text)`（`client.js:14863-14869`）；折叠 span 即"在光标处插入"，光标落在插入文本之后。
- **保留草稿与引用 chip**：只替换 span；契约注释明说 "without replacing subsequent edits or reference chips"（`input.d.ts:246-249`）。
- **版本守卫**：`span.draftRev !== this.rev` → 返回 false；`frozen(phase)`（`adjudicating|submitting|sending`）或 disposed → 返回 false（actions 实现 `client.js:15374-15378`，`frozen` 定义 `:15328-15330`）。失败时用 `captureInsertion()` 重新取一次即可重试（官方 voice-input 就是 `insertText(pending, captureInsertion())`，`$INST/dsh-experimental-client-ui-voice-input/lib/client.js:2051`；插成功前它先 `captureInsertion()`，`:1948`，失败逻辑 `:1929-1933`）。
- **多行 = 原样保留**（关键验证）：
  - Lexical `RangeSelection.insertText` 最终 `spliceText` 是纯字符串拼接，不把 `\n` 转成段落节点：`TextNode.spliceText` `client.js:7999-8013`、`RangeSelection.insertText` `client.js:8499-8551`。
  - 渲染层 `white-space: pre-wrap`：TextNode `createDOM` 设置 `n.style.whiteSpace = "pre-wrap"`（`client.js:7929`），composer CSS `.uV2eYG_input{white-space:pre-wrap;...}`（`client.js:21701`），所以文本节点里的 `\n` 在输入框里正常换行显示。
  - 投影层 `$composerLayout` 对 text 节点原样取 text（`client.js:14613-14733`），`$projectComposer` 的 `draft`/粘贴文本保留 `\n`（`client.js:14736-14786`）；提交时按这个 clipboard projection 序列化 → 换行、空行、``` 围栏都不丢。
  - 唯一会改字的是"私有区占位符清洗" `REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu`（`client.js:14891`；`insertAsyncText` 里 `:15119-15127` 执行），正常 Markdown/HTML 不含这些码位，不影响。
- **不聚焦、不滚动**：`actions.insertText` → `draftEditor.insertAsyncText` → `applyEdit`（`client.js:14986-14996` 只做 `editor.update(...,{discrete:true,tag})`），没有 `focus()`/scroll。对比：**官方 `insertQuote` 插入后会 `this.focus()`**（shell `client.js:15465-15471`，`focus` 实现 `:15793-15796` 用 `focus({preventScroll:true})` + Lexical 恢复上次选区）。所以若要"官方引用同款体感"（插完光标回到输入框），可显式调用一次 `SessionInput.focus()`（需服务路径，见 §6）；不调则焦点留在侧栏。
- **"不发送"保证**：`insertText` 只改草稿；提交只发生在显式 `InputActions.submit()` / `SessionInput.submit()` / 回车仲裁（`submit` 在 `input.d.ts:167-204` 是独立方法）。本方案不调用 submit，所以**不会自动发送**；用户之后自己按 Enter 才发送（那是用户动作）。
- **撤销**：一次 `editor.update`，tag `Co`，单步撤销会把整块一起去掉（`insertAsyncText` `:15119-15127`）。

### 3.2 `setDraft(text)`

- 契约："Replace the whole draft with plain text, removing inline reference chips."（`input.d.ts:252-253`）。
- 实现：placeholder 清洗 → `nl().clear()` → `$appendParagraphs(clean)`（editor `:15033-15044`）。`$appendParagraphs` 对 `text.split("\n")` **每行一段、空行也生成空段落、caret 到末尾**（`client.js:14897-14904`）→ 多行/空行/围栏都不丢，但**整份草稿被替换、引用 chip 被清掉、不可与旧草稿合并**。
- 适合：空草稿初始化 / 明确的"覆盖"场景；**不适合**作为日常插入兜底（会吞用户已输入内容）。

### 3.3 `insertQuote(text)`

- 官方「引用文本」调用它：`QuoteSelectionAction` 里 `if (!inputActions.insertQuote(text)) return; clearSelection(); dismiss();`（`$INST/dsh-message-quotes/lib/client.js`，组件类型 `types/client/QuoteSelection.d.ts:7`）。
- 实现：在光标处插入 `[QuoteNode, 空格]` 原子 chip（editor `:15186-15195`，shell `:15465-15471`），序列化为 Markdown blockquote（每行 `> ` 前缀，message-quotes `README.zh.md`）。
- **不适合我们**：整段元素上下文（selector + ```html 围栏``` + 样式 bullet）会变成一个大引用 chip，围栏/空行被按行加 `> `，与"插入 Markdown 上下文块"不是同一件事；且它是原子节点，用户体验上不可逐段编辑。

### 3.4 `insertReference(ref, span)`

- 插入引用 chip（`ReferenceInsert{source,ref,label,appearance,clipboardText}`），chip 后自动补一个分隔空格（`InputActions` 注释 `input.d.ts:258-260`；`SessionInputShell.insertReference` `:15735-15743` 有 phase 限制 plain/claimed + draftRev 守卫）。
- 只适合"文件/会话引用"，我们的 HTML 元素块不是引用，不用。

### 3.5 底层 scoped 事件（无 slot props 时的等价通道，了解即可）

`SessionInputShell` 在会话作用域注册了 4 个 `slash/input-*` 事件监听（`client.js:16200-16205`），其中 `:16203`：

```js
actx.on("slash/input-insert-text", (req) => shell.insertText(req.text, req.span, req.continue === true) ? true : void 0)
```

监听体走 shell 的 `insertText`（`:15771-15774`，`draftRev` 守卫 + `draftEditor.replaceText`，**没有 frozen 守卫**）。生产端先例：input-trigger 插件 `actx.bail(actx, "slash/input-insert-text", {text, span, ...})` 并比较 `=== true`（`$INST/dsh-client-ui-input-trigger/lib/client.js:1358-1381`）；commands 插件用 `binding.ctx.bail(binding.ctx, "slash/input-consume-token", ...)`（`$INST/dsh-client-ui-commands/lib/client.js:1460,:1723`）。注意这条路要自己构造 `TokenSpan`（`draftRev` 从 `input.state.getSnapshot().draftRev` 取），不含 `captureInsertion`，仅在拿不到 `inputActions` 时才考虑。

---

## 4. 推荐方案与理由

**主路径（与官方 voice-input 同构，最小惊讶）：**

```js
const span = props.inputActions.captureInsertion();
props.inputActions.insertText(markdownBlock, span);   // false → 重取 span 再试一次
```

理由：

| 需求 | insertText | setDraft | insertQuote |
|---|---|---|---|
| 多行 Markdown（空行、``` 围栏、嵌套缩进） | ✅ 原样保留 | ✅ 拆段落 | ⚠️ 变成 blockquote chip |
| 保留已有草稿/引用 chip | ✅ | ❌ 清空 | ✅ |
| 光标处插入（不覆盖已选文本，受 span 控制） | ✅ | ❌ 整份替换 | ✅ |
| 不自动发送 | ✅ | ✅ | ✅ |
| 官方已有成功先例 | ✅ voice-input | 仅种子/初始化 | 仅「引用文本」 |
| 自动聚焦输入框 | ❌（需手动 `focus()`） | ❌ | ✅ |

- **用 `insertText`**：它是唯一"在光标处插入普通多行文本、保留其他内容、单步撤销、不发送"的公开动作面；voice-input 在真实产品里已经这么用（`client.js:1948,1929-1933,2051`）。
- **不要用 `setDraft` 当默认兜底**：契约明确会删除引用 chip；如果用户正在写草稿，会整份吞掉。仅在 `occurrences.length === 0` 且明确要覆盖时用（比如空草稿）。
- **不要用 `insertQuote`**：那是官方「引用文本」的 chip 语义，不是我们的元素上下文块。
- **间隔**：`insertText` 不自动加空行。若插入点位于草稿末尾且草稿非空，建议 block 前补 `"\n\n"`（否则会粘在上一行尾部）；在草稿中间插入就按用户光标原样插。

---

## 5. 依赖声明

`package.json` 的 `dsh.client`（仓库里现有声明已经是正确的，下面是语义说明）：

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-renderer"
      ],
      "immediately": true
    },
    "manifestVersion": 1
  }
}
```

- `platform` 必须是 `"web"`；必须导出 `"./client"` bundle，否则 loader 直接抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`（`$INST/dsh-client-modules/lib/index.js:789-803`；schema 解析 `:88-99`）。
- `dsh.client.inject` 是**包名数组**（不是 cordis 服务名），语义是"这些动态包先于本包加载"（module graph 排序，`dsh-client-modules/lib/index.js:472-499`）。对本插件：
  - `@deepseek-ai/dsh-client-ui-conversation`：提供 `conversation` 服务 + `inputActions`/`sessionId` 标准 props（`:22775-22794`）；
  - `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`：声明并渲染我们挂的 `sidebar.right.tab.document` / `.actions` slot（`:8021-8044`）；
  - `@deepseek-ai/dsh-client-ui-session`：session 作用域 adapter（`installScope`），保证 standard props 可用；虽然现有清单没列它，但它是 `ui-conversation`/`ui-sidebar-documentpreview` 的依赖，实际会先加载，补上更稳。
  - `@deepseek-ai/dsh-api-session-controller`、`dsh-client-locale`、`dsh-client-ui-renderer`：现有清单用到（locale、renderer 覆盖）才需要。
- bundle 内 `exports.inject`（cordis 服务名）：`["slots","locale","sessions","documentPreviews"]`（现状；`slots`/`sessions` 必需，`conversation` 只在兜底路径用 `ctx.get("conversation")` 才需要——可加 `"conversation"`，也可以继续惰性 `ctx.get`）。
- `external`：不需要。`require("react")`、`require("react/jsx-runtime")`、`require("@deepseek-ai/dsh-client-ui-primitives")` 都在基座静态表里（官方插件直接 require，未声明 external）；只有引入其它动态包模块才需要列。
- 运行时：**取 `inputActions` 不需要任何 `ctx.inject` guard 或 ready 轮询**——它是 slot 渲染 props。兜底服务路径需要 `ctx.sessions` / `ctx.conversation`，用 `ctx.get(...)` 惰性取并 try/catch。

---

## 6. SESSION 作用域：插到哪个会话，怎么拿

### 6.1 结论

- **我们的 slot 是会话作用域**：`sidebar.right.tab.document.actions` 在契约里是 `{kind:'list'; scope:'session'; owner:{readonly absolutePath:string}}`（`$INST/dsh-client-ui-sidebar-documentpreview/lib/types/client/document/contract.d.ts:67-74`），在 docpreview 的 pane-tab 注册里 children 声明 `"sidebar.right.tab.document.actions": {kind:"list", scope:"session"}`（`$INST/dsh-client-ui-sidebar-documentpreview/lib/client.js:8032-8035`），渲染处 `renderSlot("sidebar.right.tab.document.actions", fileOwner)`，`fileOwner = {absolutePath}`（同文件 `:925`、`:758`）。
- **sessionId 就在 standard props 里**：`scope:"session"` 的所有 slot 由 ui-session 的 adapter 注入合并后的 standard props（BUILTIN_SOURCE `props:["sessionId"]`，`$INST/dsh-client-ui-session/lib/client.js:755-766`；`materialize` 合并 `:1028-1047`；`installScope("session", ...)` `:1130`），而 conversation 包贡献 `inputActions`（`client.js:22775-22794`）。因此**组件里 `props.sessionId` 就是该右栏 tab 所属会话，`props.inputActions` 就是那个会话的 `SessionInputShell.actions`**。
- 官方同 scope 组件先例：`TextPreview` 直接从 props 解构 `sessionId`（docpreview `client.js:709`）；open-in-app 的 `SessionOpenInAppAction({sessionId, useSessions})` 也从 standard props 取（`$INST/dsh-client-ui-open-in-app/lib/client.js:1432-1439`）。
- **"哪个会话"的产品语义**：右侧栏 surface 是 per-session 的（`$INST/dsh-client-ui-sidebar-right/lib/types/client/service.d.ts` 头部注释："The surface is per session and its state lives in that session's store instance..."），tab 自己的 action "acts on the session the tab is in"（`contract/slots.d.ts:160-161`），只有前景会话可见（`:202-214` "Only the foreground Session is visible..."）。→ **docked 正常交互下 = 主列当前会话**；floating 面板在切会话后仍属于原会话，这是官方语义（风险见 §8）。

### 6.2 组件内主路径（推荐）

```js
// 任意 scope:"session" 的 slot 组件（正文 / header action 都一样）
function onElementPicked(markdownBlock) {
  const actions = props.inputActions;                // 一定存在（session 作用域）
  if (actions === undefined) return false;
  // 侧栏按钮按下时 composer 已失焦：投影里可能残留旧的未折叠选区，先折叠到末尾，避免覆盖用户已选文本
  const collapsed = () => {
    const span = actions.captureInsertion();
    return span.start === span.end ? span : { start: span.end, end: span.end, draftRev: span.draftRev };
  };
  if (actions.insertText(markdownBlock, collapsed())) return true;
  // capture 之后草稿被编辑推送改过 revision：重取一次（官方 voice-input 同款重试）
  return actions.insertText(markdownBlock, collapsed());
}
```

插入完成后如需"官方引用同款体感"（光标回输入框），加一步服务调用（可选）：

```js
const scope = ctx.sessions.scope(props.sessionId);
scope?.get("conversation")?.input.for(scope)?.focus();
```

### 6.3 服务兜底（无 slot props / 正文组件走注入 helper 时）

```js
function appendMarkdownToSession(ctx, sessionId, markdown) {
  const binding = ctx.sessions.binding(sessionId);        // SessionBinding: {sessionId, session, eventSource, ctx: AgentContext}
  if (binding === undefined) return false;
  const conversation = ctx.get("conversation");           // root singleton IConversation
  if (conversation === undefined) return false;
  // 契约方法：既有草稿 → 追加为新段落（保留文本与引用 chip）；空草稿 → 作为整份内容
  const result = conversation.input.requestDraftInitialization(binding, {
    prompt: markdown,
    whenDraftExists: "append",
  });
  if (result !== "applied") return false;                 // 'preserved' | 'blocked'
  // 可选：光标回输入框
  try { conversation.input.for(binding.ctx)?.focus(); } catch {}
  return true;
}
```

- `requestDraftInitialization` 实现（`client.js:15532-15551`）：`replace` → `setDraft`；空草稿 → `setDraft`；`append` → `this.draftEditor.appendDraft(options.prompt)`；`blocked` 只在 disposed/frozen 时。
- 为什么不用 `scope.get("conversation")` + `input.appendDraft(...)`：`appendDraft` 不存在于 shell（§0.2），且 `sessions.scope(id)` 只在会话 retained 时返回 ctx（契约 "Borrow an already-retained Agent-scoped Context without extending its lifetime"；官方 queue-dock 先例 `client.js:19936-19947` 就是 `scope(id)` + `get("conversation")`）。`ctx.sessions.binding(id)` 更直接，且 `requestDraftInitialization` 自己校验 binding 身份。
- `ctx.uiConversation` 只有只读快照/交互面（`uiConversation.binding(binding)` 给 snapshot store、`imageUrl`、`userText`、`interactions` 等，`client.js:22775-22794` 的 resolve 里可见），**没有输入写入 API，不是"当前会话"的插入替代方案**。
- "当前会话"没有独立 root 服务：会话身份来自 slot 作用域（`props.sessionId`）。若某天要在非 slot 上下文找"主列当前会话"，可用 `ctx.sessions.list`/`uiSession.adapter.current.getSnapshot().key`（renderer-facing，未验证，不建议依赖）。

---

## 7. 防御式 copy-paste 实现（推荐直接替换 `lib/client.js` 的插入段）

```js
/**
 * 主路径：把 Markdown 插进会话输入框（不发送）。
 * @param props - 任意 scope:"session" slot 组件的 props（含 inputActions/sessionId/useInput）。
 * @param ctx   - apply 的根 ctx（仅兜底路径使用）。
 * @param markdown - 生成的上下文块（多行、``` 围栏均可）。
 * @param inputState - 组件顶层读好的快照：const inputState = props.useInput((s) => s)（含 draft/occurrences）。
 * @returns {boolean} 是否已插入。
 */
function insertMarkdownIntoSession(props, ctx, markdown, inputState) {
  const actions = props.inputActions;
  const sessionId = props.sessionId;
  const draft = inputState.draft;

  // 1) 官方同款：insertText at revision-guarded span（保留草稿与引用 chip，多行原样，不发送）
  if (actions !== undefined && typeof actions.insertText === "function") {
    const collapsed = () => {
      const span = actions.captureInsertion();
      // composer 失焦后投影可能残留旧选区：折叠到末尾，避免覆盖用户已选文本
      return span.start === span.end
        ? span
        : { start: span.end, end: span.end, draftRev: span.draftRev };
    };
    const withGap = (span) => {
      // 仅在"草稿末尾插入"时补空行分隔；草稿中间按用户光标原样插
      const atEnd = span.start === span.end && span.start >= draft.length;
      return atEnd && draft !== "" && !draft.endsWith("\n") ? "\n\n" + markdown : markdown;
    };
    const first = collapsed();
    if (actions.insertText(withGap(first), first)) return true;
    const retry = collapsed(); // 捕获后草稿被编辑推送改过 revision：重取一次
    if (actions.insertText(withGap(retry), retry)) return true;
  }

  // 2) 契约兜底：作为新段落追加（保留既有草稿与 reference chip）
  try {
    const binding = ctx.sessions.binding(sessionId);
    const conversation = ctx.get("conversation");
    if (binding !== undefined && conversation !== undefined) {
      const result = conversation.input.requestDraftInitialization(binding, {
        prompt: markdown,
        whenDraftExists: "append",
      });
      if (result === "applied") {
        try { conversation.input.for(binding.ctx)?.focus(); } catch { /* best-effort */ }
        return true;
      }
    }
  } catch (error) {
    console.warn("[dsh-web-inspect] service append failed", error);
  }

  // 3) 有损兜底：setDraft 会删除引用 chip；仅在草稿没有任何 chip 时手动合并
  if (actions !== undefined && typeof actions.setDraft === "function" && inputState.occurrences.length === 0) {
    const existing = inputState.draft === "" ? "" : inputState.draft.replace(/\s+$/u, "") + "\n\n";
    actions.setDraft(existing + markdown);
    return true;
  }

  // 4) 剪贴板 + 警告
  try {
    navigator.clipboard?.writeText(markdown);
  } catch { /* ignore */ }
  console.warn("[dsh-web-inspect] 无法插入输入框，元素上下文已复制到剪贴板");
  return false;
}
```

> 组件里的用法：在组件顶层 `const inputState = props.useInput((s) => s);`（hook 必须在 render 阶段调用，只调一次），事件处理器里再 `insertMarkdownIntoSession(props, ctx, markdown, inputState)`。`occurrences` 里是引用 chip（`input.d.ts:294-295`），有 chip 时跳过 setDraft、直接走剪贴板，**不要覆盖**。
>
> 对现有代码的具体对应：`lib/client.js:459-505` 的 `insertMarkdownIntoSession` 里 `input.appendDraft` 分支永远为 false（方法不存在），会落进 `setDraft` 覆盖逻辑 → 建议改成"`binding` + `requestDraftInitialization(append)`"，或更优：正文组件 `InspectHtmlBody` 直接用 `props.inputActions.insertText`（它是 `sidebar.right.tab.document` 的 session 作用域 slot，标准 props 同样带 `inputActions`/`sessionId`）。

---

## 8. 风险与未验证项

1. **运行时未实测**：GUI 未认证（401），以上全部来自磁盘源码静态核对。`dsh-client-ui-slots` 包不在磁盘（是各插件的 devDependency，由 web 运行时加载），slot 的 props 注入细节按 `ui-session` 的 `materialize` + `installScope` + 类型契约 + cordis-client-runner 目录交叉验证，未能跑通真实点击。
2. **失焦后的旧选区**：`captureInsertion` 读缓存投影（`refreshProjection` 只在 editor update 时刷新，`client.js:15015-15019`），composer 失焦时 `projection.selection` 可能仍是失焦前的选区 → 代码已折叠到 `span.end`，避免覆盖已选文本；是否还有别的情况残留，未实测。
3. **`span` 坐标与 `draft` 坐标**：`TokenSpan` 是 detect 坐标，`InputState.draft` 是 clipboard projection；有 reference chip 时两者长度可能不同。§7 的 `withGap` 只在"末尾"启发式补空行，含 chip 草稿可能判断不准（最坏情况只是多/少一个空行，不影响正确性）。
4. **`requestDraftInitialization` 的语义**是"新任务请求/初始化"（注释 "Apply one new-task request to this already-initialized input model"），用于兜底追加没问题，但它是给 draft seed 设计的；若后续它在其他路径被调用（同会话新任务）可能与用户手写草稿的 append 语义交织，走主路径可完全避开。
5. **floating 面板 + 切换会话**：action 作用于 tab 所属会话（官方语义），不是屏上主列会话；若产品要求"永远插当前屏上会话"，需要自己判断前景会话并可能切换 tab（不建议改官方语义）。
6. **空草稿**:`insertText` 对空草稿的 Lexical 插入是静态推断（`$replaceDetectSpanWithText` → `insertText`），未实测；但 voice-input 在真实产品里从空草稿开始录音插入，风险低。
7. **`setDraft` 兜底**必须避免有 chip 的草稿（契约明说删除 inline reference chips）。
8. **slash 命令解析**：`insertText`/`appendDraft` 都是普通文档编辑；输入触发器只对草稿开头 "/" 与光标处 @ token 有反应，我们的块不以 "/" 开头、结尾也不是 @，风险低（trigger controller 细节未深究）。
9. **私有区字符**：U+E100-E11D / U+FFFC 会被清洗（`client.js:14891`），正常 HTML/Markdown 不含。

---

## 9. 证据索引（file:line）

路径前缀 `$INST`（见文首）。**加粗**为最关键几处。

- 契约：`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:82-86`（InsertTextRequest）、`:150-155`（scoped event）、`:158-166`（InputTarget）、`:167-204`（SessionInput）、`:206-217`（SessionInputResolver）、`:219-236`（DraftInitializationOptions/Result）、**`:239-263`（InputActions，含 insertText/captureInsertion/setDraft 语义注释）**、`:273-298`（InputState）。
- `contract/draft-editor.d.ts:6-10`（TokenSpan）、`:12-18`（ReferenceInsert）、`:22-27`（DraftQuote）、`:113-132`（Occurrence）。
- `contract/slots.d.ts:477-497`（Global/Session/SessionMaybe 标准 props）；`dsh-client-ui-session/lib/types/client/index.d.ts:72-95`（sessionId/useSession 等）。
- 槽位契约：`dsh-client-ui-sidebar-documentpreview/lib/types/client/document/contract.d.ts:67-74`（actions slot = list/session/owner{absolutePath}）。
- 渲染/注册：`dsh-client-ui-sidebar-documentpreview/lib/client.js:709`（TextPreview 从 props 取 sessionId）、`:758`（fileOwner）、**`:925`（renderSlot actions）**、**`:8021-8044`（children 声明 actions scope session，`:8032`）**。
- 标准 props 机制：`dsh-client-ui-session/lib/client.js:755-766`（BUILTIN_SOURCE props:["sessionId"]）、`:865-884`（provide）、**`:1028-1047`（materialize 合并 props）**、**`:1130`（installScope("session")）**；`dsh-client-ui-conversation/lib/client.js:22775-22794`（provide props:["inputActions"]）。
- slot 目录（runtime 文档）：`dsh-cordis-client-runner/lib/client.js:6535-6590`（`sidebar.right.tab.document.actions` 的 standardProps 含 `inputActions`/`sessionId`，ownerProps 目录值不全）。
- 实现：`dsh-client-ui-conversation/lib/client.js:15328-15330`（frozen）、`:15357`（SessionInputShell）、**`:15369-15403`（actions 面）**、`:15370-15373`（captureInsertion）、`:15374-15378`（insertText actions）、`:15452`（shell setDraft）、**`:15465-15471`（shell insertQuote + focus）**、**`:15532-15551`（requestDraftInitialization）**、`:15682-15686`（shell caretSpan）、`:15771-15774`（shell insertText / 事件体）、`:15793-15796`（focus）、`:15015-15019`（refreshProjection）、`:15033-15044`（editor setDraft）、**`:15051-15065`（editor appendDraft）**、`:15092-15098`（editor caretSpan）、`:15106-15112`（replaceText）、**`:15119-15127`（insertAsyncText）**、`:15186-15195`（editor insertQuote）、**`:14863-14869`（$replaceDetectSpanWithText）**、`:14891`（REFERENCE_PLACEHOLDER_RE）、**`:14897-14904`（$appendParagraphs）**、`:14613-14733`（$composerLayout）、`:14736-14786`（$projectComposer）、`:16200-16205`（scoped 事件监听，insert-text 在 `:16203`）、**`:16126-16134`（InputHub.for → shellFor）**、`:19936-19947`（queue-dock 的 scope→get("conversation") 先例）、`:22530-22537`（scopedConversation 先例）。
- Lexical：`dsh-client-ui-conversation/lib/client.js:7929`（TextNode pre-wrap）、`:7999-8013`（spliceText 原文拼接）、`:8499-8551`（RangeSelection.insertText）、`:21701`（composer CSS white-space:pre-wrap）。
- 模块系统：`dsh-client-modules/lib/index.js:88-99`（parseDshClient）、`:789-803`（resolveMeta，platform/"./client" 校验）、`:472-499`（orderByModuleGraph / external 语义）；`README.zh.md`（dsh.client 声明、/plugins、__ModuleLoader__）。
- 官方先例：`dsh-message-quotes/lib/client.js` 头部/尾部（模块形状、apply/inject）、`README.zh.md`（引用 = blockquote，每行 `> `）；`dsh-client-ui-open-in-app/lib/client.js:1432-1439`（session-scope action 从 props 取 sessionId/useSessions）、`:1461-1466`（actions slot 注册）；`dsh-experimental-client-ui-voice-input/lib/client.js:1948,1929-1933,2051`（captureInsertion → insertText → 冲突重试）。
- 侧栏会话语义：`dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts:160-161`（"each acts on the session the tab is in"）、`:202-214`（"Only the foreground Session is visible"）；`.../service.d.ts` 头部注释（surface per session、tabActions 作用于 tab 所属会话）。
