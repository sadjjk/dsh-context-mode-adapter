window.__ModuleLoader__.load({
	id: "dsh-context-mode-adapter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.ts
		/**
		* dsh-context-mode-adapter — client half(dsh-context 模式,0.2.0-rc.2 内核对齐)
		*
		* 两个 seat:
		*  - plugins.bundle.config(configForms 驱动):插件管理页 bundle 行下配置卡,2 个开关。
		*    0.2.0 内核:仅当 host Config 声明 .volatile() 字段(describe 投影服务本 namespace)时,
		*    forms.whileServed([NS]) 才触发注册。
		*  - settings.plugin.item(settingsScope):0.1.x 内核的设置页行卡。0.2.0 已移除该 slot 与
		*    settingsScope 服务(seat 保留只为跨版本兼容,回调永不执行,无副作用)。
		*
		* 状态流:createContextSettings 本地 store ← attach(bound scope) 的 getSnapshot/subscribe;
		* 组件经 seat 的 useContextSettings hook 读状态、props.set 写回。
		*
		* 样式:require 内核 baseline 组件库 @deepseek-ai/dsh-client-ui-primitives 的 Switch
		* (role="switch",自带样式与 CSS 注入),行布局与文案用本插件注入的
		* <style data-plugin-css>,颜色全部走内核 --dsw-alias-* 变量,跟随明暗主题。
		*/
		const NS = "dsh-context-mode-adapter";
		const DETECT_ROUTE = "/api/dsh-context-mode-adapter/detect";
		const CSS_TAG_ID = `${NS}/settings.css`;
		const CSS = `
.dsh-cmb-prefs { display: flex; flex-direction: column; gap: 16px; }
.dsh-cmb-group { font-size: 14px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-primary, inherit); }
.dsh-cmb-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #999)); }
.dsh-cmb-info { display: flex; flex-direction: column; gap: 9px; }
.dsh-cmb-kv { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.dsh-cmb-kvkey { font-size: 13px; font-weight: 500; line-height: 1.4; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary, #999)); flex: none; }
.dsh-cmb-kvval { font-size: 13px; line-height: 1.4; color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary, inherit)); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-cmb-rows { display: flex; flex-direction: column; gap: 12px; }
.dsh-cmb-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.dsh-cmb-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-cmb-label { font-size: 13px; font-weight: 500; line-height: 1.4; color: var(--dsw-alias-label-primary, inherit); }
.dsh-cmb-label-muted { color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary, #999)); }
.dsh-cmb-desc { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #999)); }
/* 数值框:极简贴右 —— 无边框,值用次级色,hover 出底线,focus 变主色 */
.dsh-cmb-value-input {
  flex: none; width: 52px; padding: 3px 6px;
  font-size: 13px; text-align: right; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary, #999));
  background: transparent; border: none; border-bottom: 1px dashed transparent; border-radius: 0;
}
.dsh-cmb-value-input:hover:not(:disabled) { border-bottom-color: rgba(127, 127, 127, 0.4); }
.dsh-cmb-value-input:focus { outline: none; color: var(--dsw-alias-label-primary, inherit); border-bottom-color: var(--dsw-alias-label-primary, rgba(127, 127, 127, 0.6)); }
.dsh-cmb-value-input:disabled { opacity: 0.45; }
`;
		/** C2 路由拦截说明清单([descKey, 工具名],顺序即展示顺序;label 中英通用) */
		const ROUTE_ITEMS = [
			["route.bash", "Bash"],
			["route.read", "Read"],
			["route.webfetch", "WebFetch"],
			["route.grep", "Grep"],
			["route.agent", "Agent"],
			["route.mcp", "MCP"]
		];
		/** C6:MCP 工具静态清单(与 host TOOL_TOGGLES 同源语义;field 为配置字段名) */
		const TOOL_ITEMS = [
			{
				field: "ctxSearchEnabled",
				tool: "ctx_search",
				descKey: "tool.ctxSearch"
			},
			{
				field: "ctxExecuteEnabled",
				tool: "ctx_execute",
				descKey: "tool.ctxExecute"
			},
			{
				field: "ctxExecuteFileEnabled",
				tool: "ctx_execute_file",
				descKey: "tool.ctxExecuteFile"
			},
			{
				field: "ctxBatchExecuteEnabled",
				tool: "ctx_batch_execute",
				descKey: "tool.ctxBatchExecute"
			},
			{
				field: "ctxFetchAndIndexEnabled",
				tool: "ctx_fetch_and_index",
				descKey: "tool.ctxFetchAndIndex"
			},
			{
				field: "ctxIndexEnabled",
				tool: "ctx_index",
				descKey: "tool.ctxIndex"
			},
			{
				field: "ctxStatsEnabled",
				tool: "ctx_stats",
				descKey: "tool.ctxStats"
			},
			{
				field: "ctxDoctorEnabled",
				tool: "ctx_doctor",
				descKey: "tool.ctxDoctor"
			},
			{
				field: "ctxInsightEnabled",
				tool: "ctx_insight",
				descKey: "tool.ctxInsight"
			},
			{
				field: "ctxUpgradeEnabled",
				tool: "ctx_upgrade",
				descKey: "tool.ctxUpgrade"
			},
			{
				field: "ctxPurgeEnabled",
				tool: "ctx_purge",
				descKey: "tool.ctxPurge"
			}
		];
		const DICT_ZH = {
			"settings.title": "Context Mode Adapter",
			"settings.groupPaths": "依赖路径",
			"settings.groupTools": "Tools 工具",
			"settings.groupRouting": "路由拦截",
			"route.bash": "curl/wget 抓网页、内联 HTTP(fetch/requests)、mvn/gradle/sbt 构建 → 命令被替换为沙箱工具提示",
			"route.read": ">50KB 大文件 → 附加提示,建议改用 ctx_execute_file",
			"route.webfetch": "一律拒绝 → 改用 ctx_fetch_and_index / ctx_search",
			"route.grep": "首次调用附加提示",
			"route.agent": "子代理自动注入沙箱工具引导",
			"route.mcp": "外部工具,每 10 次提示一次",
			"route.bounded": "pwd、git status 等有界命令不拦截",
			"settings.contextModePath": "context-mode 路径",
			"settings.storageRoot": "存储根",
			"settings.notDetected": "未检测到 context-mode，请执行 npm install -g context-mode 安装后重启",
			"settings.readOnly": "当前环境为只读,设置不可修改",
			"settings.detection": "检测信息",
			"settings.groupToolsDesc": "关闭的工具不会注册给 AI,完全不占用上下文",
			"settings.presenceWindow": "注入尾部节点",
			"settings.presenceWindowDesc": "尾部 N 个节点内已有注入块则本轮不重复注入;约等于轮次对话:纯聊天约 15~20 轮,带工具约 4~6 轮,重度工具调用约 2~4 轮",
			"tool.ctxSearch": "上下文检索",
			"tool.ctxExecute": "沙箱执行代码",
			"tool.ctxExecuteFile": "沙箱分析文件",
			"tool.ctxBatchExecute": "批量命令采集",
			"tool.ctxFetchAndIndex": "网页抓取索引",
			"tool.ctxIndex": "内容索引入库",
			"tool.ctxStats": "统计与节省报表",
			"tool.ctxDoctor": "环境自检",
			"tool.ctxInsight": "会话分析面板",
			"tool.ctxUpgrade": "自升级",
			"tool.ctxPurge": "知识库清空"
		};
		const DICT_EN = {
			"settings.title": "Context Mode Adapter",
			"settings.groupPaths": "Dependency paths",
			"settings.groupTools": "Tools",
			"settings.groupRouting": "Routing interception",
			"route.bash": "curl/wget fetches, inline HTTP (fetch/requests), mvn/gradle/sbt builds → command replaced with sandbox hints",
			"route.read": "files >50KB → hint to use ctx_execute_file",
			"route.webfetch": "always denied → use ctx_fetch_and_index / ctx_search",
			"route.grep": "first-call hint",
			"route.agent": "subagents get sandbox guidance injected",
			"route.mcp": "external tools, hinted every 10 calls",
			"route.bounded": "bounded commands (pwd, git status) pass through",
			"settings.contextModePath": "context-mode path",
			"settings.storageRoot": "Storage root",
			"settings.notDetected": "context-mode not detected; run npm install -g context-mode and restart",
			"settings.readOnly": "Read-only view",
			"settings.detection": "Detection",
			"settings.groupToolsDesc": "Disabled tools are not registered to the AI at all — zero context cost",
			"settings.presenceWindow": "Injection tail window",
			"settings.presenceWindowDesc": "Skip re-injection while a block exists in the last N nodes; roughly turns of conversation: ~15–20 for plain chat, ~4–6 with tools, ~2–4 with heavy tool use",
			"tool.ctxSearch": "Search indexed context",
			"tool.ctxExecute": "Execute code in sandbox",
			"tool.ctxExecuteFile": "Analyze files in sandbox",
			"tool.ctxBatchExecute": "Batch command harvesting",
			"tool.ctxFetchAndIndex": "Fetch & index web pages",
			"tool.ctxIndex": "Index content into library",
			"tool.ctxStats": "Stats & savings report",
			"tool.ctxDoctor": "Environment self-check",
			"tool.ctxInsight": "Session insight dashboard",
			"tool.ctxUpgrade": "Self-upgrade",
			"tool.ctxPurge": "Knowledge-base purge"
		};
		/** 插件 CSS 一次性注入(materialize 时执行;重复 materialize 由 data-plugin-css 去重)。 */
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		const h = react.createElement;
		/** 插件本地偏好 store(照 dsh-context createContextSettings:attach bound scope 同步+写回) */
		function createContextSettings() {
			const PRESENCE_WINDOW_FALLBACK = 40;
			let state = {
				status: "loading",
				writable: false,
				presenceWindow: PRESENCE_WINDOW_FALLBACK,
				...Object.fromEntries(TOOL_ITEMS.map((item) => [item.field, true]))
			};
			let scope = null;
			const listeners = /* @__PURE__ */ new Set();
			const publish = () => {
				for (const l of listeners) l();
			};
			const unwrapVolatile = (v) => typeof v === "object" && v !== null && "get" in v ? v.get() : v;
			const sync = (bound) => {
				try {
					const snap = bound.getSnapshot();
					const raw = snap?.value ?? {};
					const next = {
						status: snap?.status === "ready" || snap?.status === "unavailable" ? snap.status : "loading",
						writable: Boolean(snap?.writable),
						presenceWindow: typeof unwrapVolatile(raw.presenceWindow) === "number" ? unwrapVolatile(raw.presenceWindow) : PRESENCE_WINDOW_FALLBACK,
						...Object.fromEntries(TOOL_ITEMS.map((item) => [item.field, raw[item.field] ?? true]))
					};
					const toolsDirty = TOOL_ITEMS.some((item) => next[item.field] !== state[item.field]);
					const windowDirty = next.presenceWindow !== state.presenceWindow;
					if (next.status !== state.status || next.writable !== state.writable || toolsDirty || windowDirty) {
						state = next;
						publish();
					}
				} catch {}
			};
			return {
				store: {
					subscribe(listener) {
						listeners.add(listener);
						return () => {
							listeners.delete(listener);
						};
					},
					getSnapshot: () => state
				},
				attach(bound) {
					if (!bound) return () => {};
					scope = bound;
					sync(bound);
					try {
						return bound.subscribe(() => sync(bound));
					} catch {
						return () => {};
					}
				},
				set(field, value) {
					try {
						scope?.set?.(field, value);
					} catch {}
				}
			};
		}
		/** detect route 只读信息(设置页兼容卡用) */
		function useDetect() {
			const [data, setData] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const json = await (await fetch(DETECT_ROUTE, { method: "POST" })).json();
						if (alive) setData(json);
					} catch {}
				})();
				return () => {
					alive = false;
				};
			}, []);
			return data;
		}
		/** 偏好行:左(标题+描述)右 Switch(内核 primitives,role="switch") */
		function PrefRow(props) {
			const { Switch } = props;
			const label = props.labelText ?? props.t(props.labelKey ?? "");
			return h("div", { className: "dsh-cmb-row" }, h("div", { className: "dsh-cmb-text" }, h("span", { className: props.labelMuted ? "dsh-cmb-label dsh-cmb-label-muted" : "dsh-cmb-label" }, label), h("span", { className: "dsh-cmb-desc" }, props.t(props.descKey))), h(Switch, {
				checked: props.checked,
				disabled: props.disabled,
				label,
				onChange: props.onChange
			}));
		}
		/** C2 分组小节标题 */
		function GroupLabel(props) {
			return h("div", { className: "dsh-cmb-group" }, props.t(props.labelKey));
		}
		/** C6 工具组:11 行 Switch(注册集合开关;默认 8 开 3 关) */
		function ToolRows(props) {
			const { t, Switch, state, disabled, set } = props;
			return h("div", { className: "dsh-cmb-rows" }, TOOL_ITEMS.map((item) => h(PrefRow, {
				t,
				Switch,
				labelText: item.tool,
				descKey: item.descKey,
				checked: Boolean(state?.[item.field] ?? true),
				disabled,
				labelMuted: true,
				onChange: (v) => set(item.field, v)
			})));
		}
		/**
		* 2026-10-09:注入尾部节点窗口行(工具组末尾;volatile 即改即生效,下一轮 pre-step 采用)。
		* 行式布局:左标题(主色)+说明(灰),右极简数值框(贴最右、窄、值灰色,hover 出底线)。
		* uncontrolled:打字自由,失焦提交(合法 clamp 写回,非法/空回落当前生效值),Enter 同失焦。
		*/
		function PresenceWindowRow(props) {
			const { t, state, disabled, set } = props;
			const current = String(state?.presenceWindow ?? 40);
			const clamp = (n) => Math.min(500, Math.max(10, Math.round(n)));
			return h("div", { className: "dsh-cmb-row" }, h("div", { className: "dsh-cmb-text" }, h("span", { className: "dsh-cmb-label" }, t("settings.presenceWindow")), h("span", { className: "dsh-cmb-desc" }, t("settings.presenceWindowDesc"))), h("input", {
				className: "dsh-cmb-value-input",
				key: current,
				defaultValue: current,
				inputMode: "numeric",
				disabled,
				onBlur: (e) => {
					const n = Number(String(e.target.value).trim());
					if (Number.isFinite(n) && n > 0) {
						const c = clamp(n);
						e.target.value = String(c);
						if (c !== state?.presenceWindow) set("presenceWindow", c);
					} else e.target.value = current;
				},
				onKeyDown: (e) => {
					if (e.key === "Enter") e.target.blur();
				}
			}));
		}
		function ReadOnlyNote(props) {
			return h("p", {
				className: "dsh-cmb-note",
				role: "status"
			}, props.t("settings.readOnly"));
		}
		function useSettingsState(props) {
			return typeof props.useContextSettings === "function" ? props.useContextSettings((s) => s) : void 0;
		}
		/** C2 依赖路径组内容:仅路径/存储根(工具超时为实现细节,不再展示) */
		function InfoBlock(props) {
			const { t, data } = props;
			return h("div", { className: "dsh-cmb-info" }, h("div", { className: "dsh-cmb-kv" }, h("span", { className: "dsh-cmb-kvkey" }, t("settings.contextModePath")), h("span", {
				className: "dsh-cmb-kvval",
				title: data?.contextModePath
			}, data?.contextModePath || t("settings.notDetected"))), h("div", { className: "dsh-cmb-kv" }, h("span", { className: "dsh-cmb-kvkey" }, t("settings.storageRoot")), h("span", {
				className: "dsh-cmb-kvval",
				title: data?.storageRoot
			}, data?.storageRoot || "~/.dsh/context-mode")));
		}
		/** C2 卡片主体:依赖路径 → MCP 工具 */
		function CardBody(props) {
			const { t, Switch, state, disabled, set, data } = props;
			return [
				h(GroupLabel, {
					t,
					labelKey: "settings.groupPaths"
				}),
				h(InfoBlock, {
					t,
					data
				}),
				h(GroupLabel, {
					t,
					labelKey: "settings.groupTools"
				}),
				h("div", { className: "dsh-cmb-desc" }, t("settings.groupToolsDesc")),
				h(ToolRows, {
					t,
					Switch,
					state,
					disabled,
					set
				}),
				h(PresenceWindowRow, {
					t,
					state,
					disabled,
					set
				}),
				h(GroupLabel, {
					t,
					labelKey: "settings.groupRouting"
				}),
				h("div", { className: "dsh-cmb-rows" }, ROUTE_ITEMS.map(([key, label]) => h("div", { className: "dsh-cmb-row" }, h("div", { className: "dsh-cmb-text" }, h("span", { className: "dsh-cmb-label" }, label), h("span", { className: "dsh-cmb-desc" }, t(key))))), h("p", { className: "dsh-cmb-note" }, t("route.bounded")))
			];
		}
		/** 插件管理页 bundle 行配置卡(configForms 驱动,0.2.0 主卡) */
		function PluginConfigCard(props) {
			const state = useSettingsState(props);
			const data = useDetect();
			if (state === void 0 || state.status === "unavailable") return null;
			const disabled = state.status !== "ready" || !state.writable;
			return h("div", { className: "dsh-cmb-prefs" }, !state.writable && state.status === "ready" ? h(ReadOnlyNote, { t: props.t }) : null, h(CardBody, {
				t: props.t,
				Switch: props.Switch,
				state,
				disabled,
				set: props.set,
				data
			}));
		}
		/** 设置页插件行卡(0.1.x settingsScope seat):0.2.0 已移除该 slot,seat 保留为跨版本兼容 */
		function SettingsCard(props) {
			const state = useSettingsState(props);
			const data = useDetect();
			const disabled = !state || state.status !== "ready" || !state.writable;
			return h("div", { className: "dsh-cmb-prefs" }, state && !state.writable && state.status === "ready" ? h(ReadOnlyNote, { t: props.t }) : null, h(CardBody, {
				t: props.t,
				Switch: props.Switch,
				state,
				disabled,
				set: props.set,
				data
			}));
		}
		const name = NS;
		const inject = ["slots", "locale"];
		function apply(ctx) {
			injectStyles();
			ctx.effect?.(() => ctx.locale?.register(NS, {
				zh: DICT_ZH,
				en: DICT_EN
			}), "bridge: dictionaries");
			const t = ctx.locale?.bind?.(NS) ?? ((key) => DICT_ZH[key] ?? key);
			const Switch = require("@deepseek-ai/dsh-client-ui-primitives")?.Switch;
			const settings = createContextSettings();
			const face = () => ({
				hooks: { contextSettings: settings.store },
				t,
				Switch,
				set: (field, value) => settings.set(field, value)
			});
			ctx.inject?.(["settingsScope"], (raw) => {
				const binder = raw.settingsScope;
				if (binder === void 0 || typeof binder.bind !== "function") return;
				raw.effect?.(() => settings.attach(binder.bind({ namespace: NS })), "bridge: settings scope");
				raw.slots.inject("settings.plugin.item", () => raw.slots.register({
					name: "settings.plugin.item",
					key: NS,
					locale: NS,
					inject: face
				}, (props) => h(SettingsCard, props)));
			});
			ctx.inject?.(["configForms"], (raw) => {
				const forms = raw.configForms;
				if (forms === void 0 || typeof forms.get !== "function" || typeof forms.whileServed !== "function") return;
				raw.effect?.(() => settings.attach(forms.get(NS)), "bridge: config forms");
				raw.effect?.(() => forms.whileServed([NS], () => {
					return raw.slots.inject("plugins.bundle.config", () => raw.slots.register({
						name: "plugins.bundle.config",
						key: NS,
						locale: NS,
						inject: face
					}, (props) => h(PluginConfigCard, props)));
				}), "bridge: plugins-page card");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map