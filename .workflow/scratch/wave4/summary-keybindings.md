# Summary · Task 25 keybindings（快捷键：统一注册、可改键、设置页）

分支 `LAIJiangFeng/keybindings`。worktree 建在 `f5c2e91`（Initial commit）上：开工时 `git merge --ff-only main` 快进到 `3777730`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`、`node node_modules/electron/install.js`（本机缓存，没有下载）。写总结时 `main` 多了一个 docs 提交 `918a0e8`（Task 28 任务书），`git merge-tree --write-tree main HEAD` 退出码 0。

相对 `3777730` 有 7 个提交（30 个文件，+2184 / −21），另有本总结的 `docs(wave4)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`，没有 push，没有建 PR。没有 BLOCKED 项。没有动 Main、preload、packages。范围外改了三个组件文件，每处都只有几行，理由见「未做 / 越界项」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `b7acac8` feat(shared) | `src/shared/keybindings.ts`：动作表、默认键、`normalizeChord` / `chordFromEvent` / `formatChord` / `toAriaKeyShortcuts`、能否绑定、冲突检测、覆盖表收窄；`settings.ts` 的 `// --- keybindings ---` 块 |
| `d2a27be` feat(renderer) | `lib/keybindings/**`：改键 store、全局监听与作用域判断、动作处理函数登记、`KeybindingProvider`、侧栏会话搜索；`stores/settings.ts` 实例；`App.tsx` 挂载一行 |
| `e7ccf9c` feat(renderer) | 设置页「快捷键」（`KeybindingsSettings.tsx`）、导航加一项 |
| `0e5d5b0` fix(renderer) | 被测试 import 的模块不用 `@/` 别名、不碰 `document`（`tsconfig.node.json` 检查测试，没有 DOM 类型和这个别名） |
| `af8e431` refactor(renderer) | `Composer.tsx`：Shift+Tab / ↑ / ↓ / Enter / Shift+Enter 改成动作调用，新增运行中 Esc 停止、Ctrl+M 打开模型选择器、登记「聚焦输入框」 |
| `e4b2e55` feat(renderer) | 新建会话（Ctrl+N）、侧栏搜索框（Ctrl+K）、标题栏两个按钮的悬停提示带快捷键 |
| `4683e55` fix(renderer) | 设置页点「重置 / 全部重置」后焦点不丢（冒烟时发现） |

### 1. 动作表与按键串（`src/shared/keybindings.ts`，纯函数）

动作表 14 项（任务书 12 项，另加 ↑ / ↓ 翻历史，见注意事项 3），顺序即设置页顺序。`mod` 在 macOS 是 ⌘，其他平台是 Ctrl。

| 作用域 | 动作（默认键） |
|---|---|
| 全局（都标了 `allowInInput`） | 新建会话 `mod+n`、打开设置 `mod+,`、切换右侧面板 `mod+b`、聚焦输入框 `mod+l`、上一个 / 下一个会话 `mod+shift+[` / `mod+shift+]`、搜索会话 `mod+k` |
| 输入框 | 发送 `enter`、换行 `shift+enter`、切换审批档位 `shift+tab`、停止当前回合 `escape`（运行中）、打开模型选择器 `mod+m`、上一条 / 下一条历史消息 `arrowup` / `arrowdown` |

- **按键串**：小写，修饰键按 `ctrl+alt+shift+meta` 排在前，最后是键（字母、数字、11 个符号、`enter` `tab` `escape` `space` 方向键等命名键、`plus`、`f1`–`f24`）。
- **`normalizeChord(input, platform?)`**：规整大小写、空白、顺序与别名（`Shift+Ctrl+K` → `ctrl+shift+k`，`cmd` / `win` / `super` → `meta`，`option` → `alt`，`Esc` / `Return` / `Up` / `comma` / `BracketLeft` 等）；`ctrl++` 是 `ctrl+plus`；不给平台时 `mod` 原样保留，给了平台展开成 meta / ctrl。认不出时返回 null。
- **`chordFromEvent(event)`**：
  - 字母认键面（AZERTY 也按键帽）；
  - 数字和符号认物理位置：按着 Shift 时 `key` 会变，Ctrl+Shift+[ 的 `key` 是 `{`，靠 `code` 才认得出；非拉丁布局的字母也按 `code` 认；
  - 返回 null 的情况：只按修饰键、输入法组字中（`isComposing`）、AltGr 打字（`getModifierState('AltGraph')`）、输入法 `Process` / 死键且没带 Ctrl / Alt / Meta、认不出的键。
- **显示**：`formatChord` 在 macOS 上用符号连写，顺序 ⌃⌥⇧⌘（`⇧⌘K`、`⇧↩`、`⇧⇥`）；其他平台写成 `Ctrl+Shift+K`，meta 在 Windows 上显示为 Win、Linux 上为 Super，方向键显示为 ↑↓←→，Escape 显示为 Esc。`toAriaKeyShortcuts` 给 `aria-keyshortcuts`。
- **能否绑定 `isAllowedChord`**：要带 Ctrl / Alt / Meta。例外：F 键；输入框动作还可以单按 Enter、Tab、Esc、↑、↓（可加 Shift）。单按字母或只加 Shift 是在打字，绑上会吞掉输入。
- **冲突 `findConflict`**：
  - 同作用域同键算冲突（任务书要求）；
  - 全局动作在输入框里也响应，所以全局动作与输入框动作同键也算冲突（否则在输入框里会被输入框动作截住）；
  - 全选 / 复制 / 粘贴 / 剪切 / 撤销 / 重做（`mod+a/c/v/x/z/y`、`mod+shift+z`）保留，按平台判断（macOS 上 ⌃C 不算）。
- **settings**：`Preferences.keybindings?: KeybindingOverrides`（只存改过的动作）。
  - settings.json 读取时宽松收窄：逐条丢弃未知动作、非字符串和认不出的或这个作用域不允许的键，`__proto__` 改不到原型，一条不剩时整个字段去掉；
  - `settings:update` 严格收窄：整张表一起换，任何一条不合法整个 patch 作废，空表合法（全部重置）。
  - Main 的 handler 没改：它本来就用 shared 的收窄函数，逐字段合并。

### 2. Renderer（`src/renderer/lib/keybindings/**`）

- **`store.ts`**（`createKeybindingsStore(api, platform)`，实例在 `stores/settings.ts` 的 `// --- keybindings ---` 块）：
  - 状态：`overrides`（磁盘上的覆盖表）、`bindings`（按平台展开后生效的键）、`loaded`；
  - 写入：经 `settings:update` 把整张覆盖表写回。改键先在本地生效，回包以 Main 的记录为准；写入失败（含 IPC 抛异常）时按 Main 的记录恢复；
  - 读到磁盘之前不写（免得用空表盖掉）；还没读到时改键会先读再改，读失败就不写；
  - 读和写都只认最后一次的回包；`settings:changed` 时重读（其他窗口改过的也能拿到）；
  - 改回默认键等于去掉这一项。
- **`scope.ts`（作用域判断，纯函数）**：`globalActionOf(event, bindings)` 判断该派发的全局动作：
  - 组件已经处理过（`defaultPrevented`）的键不派发；
  - 焦点在 `role=dialog / alertdialog` 里不派发（含设置视图、Base UI 弹窗）；
  - 焦点在可打字的地方（文本 input、textarea、select、contenteditable）时，只派发标了 `allowInInput` 的动作；
  - 只认全局作用域的动作，输入框动作由 Composer 自己派发。
- **`handlers.ts`**：动作由负责的组件经 `useActionHandler` 登记，同一动作最后登记的生效；没有组件登记时 `runAction` 返回 false，监听器就不拦截这次按键（例如没选工作区时按 Ctrl+N 不会被吞掉）。
- **`KeybindingProvider`**（在 `App.tsx` 里挂一行）：
  - 在 `window` 冒泡阶段监听 keydown；
  - 自己处理打开设置、切换右侧面板、上一个 / 下一个会话（按当前工作区侧栏的顺序，首尾相接；搜索框在过滤时只在结果里走）；
  - 新建会话、聚焦输入框、搜索会话由负责的组件登记。
- **侧栏会话搜索**（原先没有搜索功能，按任务书做成「按标题过滤侧栏的简单输入」，`SessionSearch.tsx` + `sessionFilter.ts`）：
  - 「会话」标题行加一个搜索按钮（悬停提示「搜索会话 Ctrl+K」）；
  - 输入框在列表上方，按标题包含过滤，不分大小写；没有结果时列表显示「没有匹配的会话」；
  - Enter 打开第一个结果并收起，Esc 清空收起并回到输入框，空着失焦时收起；
  - 输入框里的 × 只清空，焦点留在输入框。
- **输入框辅助**：`matchAction(event, action)` 按当前生效的键判断，改键后立即生效。`insertNewline`：换行键是 Enter / Shift+Enter 时交给浏览器；改成 Ctrl+Enter、Alt+Enter 这类浏览器不会换行的键时，用 `execCommand('insertText')` 插入，撤销照样能用。`useComposerHints` 让输入框的悬停提示和 `aria-keyshortcuts` 跟着改键变。

### 3. 设置页「快捷键」（导航最后一项，图标 Keyboard）

- 两组「全局」「输入框」。每行是「动作 — 当前键 — 改键 / 重置」；「全部重置」在第一组的标题右侧，没改过时不可点。
- 改键时：
  - 当前键的位置显示「按下组合键」，按钮变成「取消」；
  - 按下组合键即录入；Esc 取消，失焦也取消；
  - 录入时按键不会冒泡：不触发按钮，不会顺带关掉设置视图，也不会派发全局快捷键。
- 拒绝录入（红字一行，不保存，继续等下一次按键）：
  - 「已被「切换右侧面板」使用」；
  - 「已被「复制」使用」（保留的编辑键）；
  - 「要带 Ctrl 或 Alt」（macOS 上是「要带 ⌘、⌃ 或 ⌥」）。
- 手改 settings.json 撞出的冲突（或以后新版本的默认键撞上改过的键），两行都标「与「X」冲突」。
- 「重置」只在改过的行显示。点了「重置 / 全部重置」之后焦点交给同一行（全部重置：第一行）的「改键」。
- 文案极简：没有页头说明、分组说明和行内说明，只有控件名与红字一行。

### 4. 现有组件的改动（都是把写死的判断换成动作调用或挂载点）

| 文件 | 改动 |
|---|---|
| `App.tsx` | 一行 import、一行 `<KeybindingProvider />` |
| `Composer.tsx` | 删掉 `hasModifier`；Shift+Tab、↑、↓、Enter 的判断各换成一个 `matchAction`；新增「运行中 Esc 停止」（5 行，排在「翻历史时 Esc 回到草稿」之后）、「Ctrl+M 打开模型选择器」（5 行，用 store 已有的 `openModelPicker`）、「换行」（4 行）；登记 `focus-composer`（1 行）；输入框的 `title` 与 `aria-keyshortcuts` 由当前键生成（2 行） |
| `NewSessionButton.tsx`（范围外） | 侧栏的小按钮登记「新建会话」，处理方式是点自己的触发器，走与点击相同的打开流程（ref、登记、`ref={trigger}` 各 1 行，另有 1 行注释，import 改 1 行、加 1 行） |
| `SessionList.tsx`（范围外） | 标题行加搜索按钮（4 行）、列表上方一行搜索框、列表按搜索过滤（2 行）、过滤后为空时显示「没有匹配的会话」（3 行） |
| `TitleBar.tsx` | 右侧面板按钮的悬停提示后面加快捷键（`<ShortcutHint>`） |
| `SettingsButton.tsx`（范围外，即「标题栏的设置按钮」） | 悬停提示后面加快捷键；设置开着时提示是「关闭设置」，不带快捷键（设置里全局键不响应） |
| `SettingsView.tsx` / `settingsViewStore.ts` | 加「快捷键」一项，放在「外观」之后（Task 24 的「通知」放在「通用」之后，两边插入的位置不同） |
| `stores/settings.ts` | 文件末尾加 `// --- keybindings ---` 块：store 实例、启动时读一次、`onChanged` 时重读 |

## 怎么验证

**基线**（`3777730`）：typecheck 0；lint 0（379 个文件）；test 127 个文件 / 1852 个用例全过。

**验收命令**（最终提交 `4683e55`，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 398 files … No fixes applied.
pnpm test       → exit 0：Test Files 133 passed (133)；Tests 1958 passed (1958)
pnpm build      → exit 0：out/main/index.js 343.46 kB、out/main/chunks/index-<hash>.js（worker）130.83 kB、out/preload/index.cjs 13.10 kB
                  out/main/index.js 里 @earendil-works 出现 0 次
```

**新增的用例**（+106 = 1958 − 1852）：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `shared/keybindings.test.ts`（新） | 63 | 规整（大小写 / 顺序 / 别名 / `++` / `mod` 保留与按平台展开 / 12 种不合法串）；事件 → 按键串（字母认键面、AZERTY、Shift 下的符号与数字认物理位置、命名键、小键盘、非拉丁字母、输入法 Process、死键、只按修饰键、组字、AltGr、产出的串都能原样认回）；三个平台的显示与 `aria-keyshortcuts`；默认键（三个平台都合法且互不冲突）；覆盖的展开与非法回落；能否绑定；冲突（同作用域、自己不算、跨作用域、保留键按平台）；覆盖表的宽松 / 严格收窄（含 `__proto__`） |
| `shared/types/settings.test.ts` | +10 | `parsePreferences` 保留 / 逐条丢弃 / 整个去掉；`parseSettings` 读回；`parsePreferencesPatch` 规整、空表、6 种拒绝 |
| `renderer/lib/keybindings/scope.test.ts`（新） | 11 | 可编辑目标（文本类 input、textarea、select、contenteditable；按钮、勾选框、单选、滑块不算）；弹窗内；`allowInInput`；**监听器的作用域判断**：默认键派发、输入框里也派发、输入框动作不经全局派发、`defaultPrevented` / 弹窗内 / 没绑定 / 只按修饰键不派发、改键后新键生效旧键失效、macOS 上 ⌘ 才是 mod |
| `renderer/lib/keybindings/store.test.ts`（新） | 9 | 读到前用默认键、按平台展开；改键立即生效并写整张表；改回默认键等于重置；单项 / 全部重置；未读先读、不覆盖磁盘；读失败不写；写失败与 IPC 抛异常时恢复；先发的回包晚到不覆盖；重读拿到新值、旧读取晚到丢弃 |
| `renderer/lib/keybindings/sessionFilter.test.ts`（新） | 5 | 按标题过滤（大小写、空白、中文）、空查询返回原数组；上一个 / 下一个首尾相接、没选中或被过滤掉时的起点、空列表 |
| `renderer/lib/keybindings/handlers.test.ts`（新） | 4 | 没有处理函数时不拦截；登记 / 注销；最后登记的生效、注销后回到前一个；重复注销 |
| `renderer/lib/keybindings/composer.test.ts`（新） | 4 | 输入框提示与 `aria-keyshortcuts`（默认、macOS、改过的键）；浏览器会不会自己换行 |

**TDD 的实际顺序**（如实说明）：

- 先写测试、跑红、再实现的：
  - `shared/keybindings`：模块不存在；
  - `settings.ts`：4 红，拒绝类用例本来就是绿的，因为未知字段原本就整体作废；
  - `lib/keybindings` 的 scope / store / handlers / sessionFilter / composer：模块都不存在。
- 没有单测、靠真机冒烟验证的：React 组件（`KeybindingsSettings`、`SessionSearch`、`KeybindingProvider`、Composer 的接线），仓库没有 DOM 测试环境；「重置后焦点不丢」也是冒烟时发现并修的。
- **变异验证**：逐个改坏关键逻辑、跑对应测试文件，15 处全部被测试抓到，跑完 `git checkout` 还原。改坏的点：
  - 弹窗里也派发；输入框里不看 `allowInInput`；`defaultPrevented` 的键照样派发；
  - 写入回包不看是不是最后一次；没读到磁盘就写；改回默认键仍留覆盖项；
  - 符号认 `key` 不认物理位置；冲突只看同作用域；全局动作也允许单按 Enter；不认 AltGr；复制不保留；
  - 先登记的生效；patch 不规整；切会话不首尾相接；Alt+Enter 当成浏览器会换行。

**真机冒烟**（`pnpm dev`，CDP 发真实键盘事件，结论来自 DOM、settings.json 和 Main inspector，不截图）：

- **环境**：
  - 隔离的 userData，settings.json 只登记一个临时 git 仓库；`RENDERER_VITE_SESSIONS_MOCK=1`，会话用内存 mock，不需要模型；
  - 设置读写走真实的 Main 和 settings.json；
  - 从 PowerShell 启动：`pnpm exec electron-vite dev --remoteDebuggingPort 9382 --inspect 9383 '--' --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`。
- **第一轮**（全新 userData；49 项通过，另 1 项是脚本问题，见本段最后一条）：
  1. **新建会话**：焦点在 body 时 Ctrl+N 打开新建会话弹层，点「创建」后输入框出现；Enter 发送，第一条消息成为会话标题。焦点在输入框里时 Ctrl+N 同样打开弹层。建了三个会话。
  2. **切会话**：Ctrl+Shift+] 切到侧栏里的下一个，再按两次首尾相接回到起点；Ctrl+Shift+[ 从第一个绕到最后一个；切过去后焦点在新会话的输入框里。
  3. **聚焦输入框**：焦点离开输入框后，Ctrl+L 把焦点放回去。
  4. **右侧面板**：在输入框里按 Ctrl+B 收起面板，settings.json 的 `sidePanelOpen` 落成 false；悬停标题栏按钮，提示是「展开右侧面板Ctrl+B」（textContent，中间有 margin）；再按 Ctrl+B 展开。
  5. **搜索会话**：
     - Ctrl+K 打开搜索框并聚焦；输入 `TASK` 只剩 alpha task / beta task；输入 `zzz` 显示「没有匹配的会话」；
     - 输入 `gam` 后 Enter：打开 gamma notes，搜索框收起，焦点回到输入框，列表恢复 3 行；
     - 再按 Ctrl+K 后按 Esc：搜索框收起，焦点回到输入框。
  6. **输入框**：
     - Shift+Enter 换行，不发送；
     - Shift+Tab 把档位从「完全放行」切到「全程审批」，焦点留在输入框；
     - Ctrl+M 打开模型选择器，焦点在「搜索模型」，Main 报窗口没有最小化（见注意事项 2）；
     - ↑ 取到上一条历史 `gamma notes`，↓ 回到空草稿；
     - 运行中按 Esc，792 ms 后回到「发送」（mock 跑完一轮要远长于此）；空闲时按 Esc 什么都不做。
  7. **设置视图**：Ctrl+, 打开设置；设置视图里按 Ctrl+B、Ctrl+N 都不响应。
  8. **快捷键页的显示**：页头「快捷键」，两组「全局」「输入框」，14 行默认键为 Ctrl+N、Ctrl+,、Ctrl+B、Ctrl+L、Ctrl+Shift+[、Ctrl+Shift+]、Ctrl+K、Enter、Shift+Enter、Shift+Tab、Esc、Ctrl+M、↑、↓；「全部重置」不可点。
  9. **快捷键页的改键**：
     - 新建会话录入 Ctrl+Alt+N，立即显示，出现「重置」；
     - 打开设置按 Ctrl+B：红字「已被「切换右侧面板」使用」，不保存，仍在录入；按 Esc 取消，键不变，设置视图没被关掉；
     - 搜索会话依次按 K、Ctrl+C、Ctrl+M，红字依次是「要带 Ctrl 或 Alt」「已被「复制」使用」「已被「打开模型选择器」使用」；再按 Ctrl+Shift+F 录入成功；
     - 发送改成 Ctrl+Enter，换行改成 Alt+Enter；
     - settings.json 的 `keybindings` 正好是 `{ new-session: ctrl+alt+n, search-sessions: ctrl+shift+f, send: ctrl+enter, newline: alt+enter }`；
     - 搜索会话那一行点「重置」：回到 Ctrl+K，「重置」隐藏，焦点落在同一行的「改键」上。
  10. **改键立即生效**（关掉设置后）：
      - 输入框悬停提示变成「Ctrl+Enter 发送，Alt+Enter 换行，↑ / ↓ 翻历史消息」；
      - 旧键 Ctrl+N 不再新建会话，Ctrl+Alt+N 打开弹层；
      - 输入 a、Enter、b、Alt+Enter、c 后输入框里是 `a\nb\nc`：Enter 由浏览器换行，Alt+Enter 是自己插入的；Ctrl+Enter 发送。
  11. 最后一步「等回合结束」超时，是脚本问题：前面 Shift+Tab 把这个会话切到了全程审批，mock 的 bash 停在等审批。在同一个应用里补跑（round1b，3 项通过）：会话等审批时按 Esc，187 ms 停下，审批条消失；控制台 0 个 error / warning。
- **第二轮**（同一个 userData，重启 dev；19 项全部通过）：
  - **重启前手改了 settings.json**，在保留第一轮写入的三项之外加了四项：
    - `open-settings: ctrl+b`：与切换右侧面板冲突；
    - `search-sessions: Mod+Shift+F`：大小写混写，用 `mod`；
    - `focus-composer: l`：不合法；
    - `no-such-action: ctrl+j`：未知动作。
  1. **改过的键重启后仍生效**：Ctrl+N 不新建会话，Ctrl+Alt+N 打开弹层；输入框提示是改过的键；Enter 换行、Ctrl+Enter 发送、Esc 停止。
  2. **`Mod+Shift+F`**：Ctrl+K 不再打开搜索，Ctrl+Shift+F 打开（mod 在 Windows 上展开成 Ctrl）。
  3. **不合法的 `l`** 被忽略，Ctrl+L 照旧聚焦输入框。
  4. **冲突的 Ctrl+B** 按动作表顺序派发给打开设置，右侧面板没动。
  5. **设置页**：
     - 改过的行显示新键并带「重置」；
     - 两行冲突都标红：「与「切换右侧面板」冲突」「与「打开设置」冲突」；
     - 搜索会话显示 Ctrl+Shift+F；聚焦输入框显示 Ctrl+L、没有「重置」（非法项不算改过）；
     - 重置打开设置后冲突消失。
  6. **全部重置**：14 行全部回到默认键，没有「重置」，按钮变灰，焦点留在设置里的「改键」上；settings.json 的 preferences 只剩 `{ theme, sidePanelOpen }`，手改的非法项也一并去掉了。
  7. 关掉设置后 Ctrl+N 立即恢复，Enter 发送恢复。
  8. **参考项**（不是本卡的行为）：焦点不在输入框时按 Ctrl+M，窗口被最小化了。用 Main inspector 还原，见注意事项 2。控制台 0 个 error / warning。
- **中途的假失败**（如实记录）：
  - 第一次跑时，等弹层的条件返回的是 DOM 节点，`returnByValue` 拿到空值，一直等不到（记忆里记过这个坑）；
  - 第二次跑时，侧栏行里的状态点也带 `title`，选错了 span；
  - 经 Main inspector 调 `app.quit()` 后应用卡在退出（CDP 不再响应），之后改为直接结束本 worktree 的 electron 进程。
  - 三次都是脚本或环境问题，产品代码没有因此改动。
- 脚本、日志、报告、临时仓库与 userData 都在 `%TEMP%\fynvra-t25-smoke-eFbXOM`：
  - 脚本：`scripts/common.mjs`、`round1.mjs`、`round1b.mjs`、`round2.mjs`、`probe.mjs`、`mutate.mjs`；
  - 报告：`report1.json`、`report1b.json`、`report2.json`、`mutations.json`；
  - 不含任何 key，可以整个删掉。本 worktree 没有残留的 electron 进程，9382 / 9383 已释放。

## 未做 / 越界项

- **范围外改了三个组件文件**（每处几行，都是任务书的动作表要求的）：
  - `NewSessionButton.tsx`：新建会话要打开的是这个组件内部状态的弹层，范围里列出的文件碰不到它。按 DOM 文字找按钮去点，Task 27 改文案后就会失效，所以改成组件自己登记（3 行 + import）。
  - `SessionList.tsx`：任务书写明「如无搜索功能，做成按标题过滤侧栏的简单输入」，过滤的就是这个列表。
  - `SettingsButton.tsx`：任务书写的是「`TitleBar.tsx` 的设置按钮」，这个按钮的组件在这个文件里。
- **`SidePanel.tsx` 没有改**：里面没有写死的快捷键判断；开关在 `TitleBar.tsx` 和 settings store 里，快捷键直接调 `toggleSidePanel`。唯一的按键判断是分隔条的 ←/→ 调宽，那是控件自己的键，不算快捷键。
- **没有改的提示文字**（范围外）：`ApprovalModePicker.tsx` 胶囊的「Shift+Tab 切换」和 `StatusBar.tsx` 的「审批档位（Shift+Tab 切换）」是写死的。改了「切换审批档位」的键之后，这两处提示会过时。各一行就能改成 `useChordLabel('cycle-approval')`，建议并进 Task 27（它要改遍组件文案）或另开小卡。
- **`docs/ARCHITECTURE.md` 没有改**：没有新 IPC 通道，`settings:update` 只是多收一个字段，文档里也没有逐字段列 Preferences。想补的话可以在 §7 后加一句：「快捷键覆盖表在 `preferences.keybindings`，经 `settings:update` 整张写回；动作表与按键串的规整、显示、冲突检测在 `src/shared/keybindings.ts`」。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，与前几张卡相同。

## 给验收人的注意事项

1. **行为变化：只有绑定的键才发送**。以前 `key === 'Enter' && !shiftKey` 就发送，Ctrl / Alt / Meta+Enter 也会发送；现在只认「发送」绑定的键（默认 Enter），Ctrl+Enter 默认什么都不做。习惯 Ctrl+Enter（或 macOS 上 ⌘↩）发送的用户可以在设置里改。
2. **Ctrl+M 在输入框外会最小化窗口**（以前就这样，不是本卡引入的）：
   - fynvra 没有调用 `Menu.setApplicationMenu`，Electron 的默认菜单在，它的「Window → Minimize」是 CmdOrCtrl+M。默认菜单里还有 Ctrl+W 关闭、Ctrl+R 重载等加速键，这些没有逐个验证；
   - 焦点在输入框里时，Composer 先处理 Ctrl+M 并 `preventDefault`，菜单不会接手（第一轮实测窗口没有最小化）；焦点在别处时，Ctrl+M 不是快捷键，菜单把窗口最小化了（第二轮参考项实测）；
   - Ctrl+M 是任务书指定的默认键，这个坑会更容易踩到。修要动 Main（不在范围内），两个方向：
     - 换成精简的应用菜单，去掉 Minimize 的加速键。注意不要直接 `setApplicationMenu(null)`：macOS 上没有 Edit 菜单时 ⌘C / ⌘V 会失效；
     - 或者把「打开模型选择器」的默认键改成别的。
3. **动作表比任务书多两项**：「上一条 / 下一条历史消息」（↑ / ↓，输入框作用域）。任务书要求把 Composer 里写死的 ↑↓ 判断换成动作调用，所以它们也进了动作表，可以改键。「光标在第一行 / 最后一行才翻」的条件保持不变。翻历史时按 Esc 回到草稿这一条仍然写死在 Esc 上，它排在「停止当前回合」之前：翻历史时按 Esc 先回到草稿，再按一次才停止。
4. **比任务书严格的两条规则**，理由都是不吞输入：
   - 冲突检测把「全局动作在输入框里也响应」算作与输入框作用域重叠，并保留复制 / 粘贴 / 撤销等编辑键；
   - 键要带 Ctrl / Alt / Meta（例外见上文）。
   不想要的话改 `scopesOverlap` / `RESERVED_CHORDS` / `isAllowedChord` 即可，都有用例。
5. **弹窗与设置视图里全局键都不响应**，包括在设置里按 Ctrl+,，Esc 照旧关闭设置。
6. **手改 settings.json 撞出的冲突**：运行时按动作表顺序先到先得，设置页两行都标红，用户改掉其中一个即可。非法项读取时丢弃，下一次写入后从文件里消失。
7. **与 Task 24 / 26 合并**：
   - `src/shared/types/settings.ts`：我的字段、`parsePreferences` 里两行、`parsePreferencesPatch` 里一个 case，都放在 `// --- keybindings ---` 注释后面、各段末尾；
   - `settings.test.ts`：独立的 `describe` 放在文件末尾；
   - `stores/settings.ts`：块放在文件末尾；
   - 导航与 `SETTINGS_SECTIONS`：「快捷键」放在「外观」之后。
   几处都是在同一位置追加，git 若报冲突应是两边都保留的相邻插入。`createSettingsStore.ts` 没有改：快捷键用自己的 store 写 `{ keybindings }`，Main 逐字段合并，不会与主题 / 右侧面板的写入互相覆盖。
8. **给 Task 27（i18n）**：本卡的中文文案有这些：
   - 动作名与保留键名在 `src/shared/keybindings.ts` 的 `ACTIONS` / `RESERVED_CHORDS`（Main 不读这些文字）；
   - `KeybindingsSettings.tsx`：组名、按钮、红字、录入提示；
   - `lib/keybindings/composer.ts`：输入框提示；
   - `lib/keybindings/SessionSearch.tsx`：搜索框、按钮；
   - `SessionList.tsx`：「没有匹配的会话」。
9. **macOS 只有单测覆盖**（⌘ 作为 mod、符号显示、默认键无冲突），没有真机验证。
10. 搜索框的查询是全局的界面状态：开着搜索切到别的工作区时，过滤条件跟着过去（搜索框也在），按 Esc 或 × 清空。
