import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
//#region src/host/path-detector.ts
/**
* dsh-context-mode-adapter — host path-detector
*
* C4 context-mode 路径自动检测，4 级优先级：
*   ① which context-mode
*   ② npm config get prefix + /bin/context-mode
*   ③ 常见路径探针（~/.npm-global/bin、/usr/local/bin、~/.bun/bin、pnpm 全局）
*   ④ nvm versions glob
*/
function detectContextModePath() {
	try {
		const p = execSync("which context-mode", {
			encoding: "utf-8",
			timeout: 5e3
		}).trim();
		if (p) return p;
	} catch {}
	try {
		const prefix = execSync("npm config get prefix", {
			encoding: "utf-8",
			timeout: 5e3
		}).trim();
		const candidate = join(prefix, "bin", "context-mode");
		if (existsSync(candidate)) return candidate;
	} catch {}
	const probes = [
		join(homedir(), ".npm-global/bin/context-mode"),
		"/usr/local/bin/context-mode",
		join(homedir(), ".bun/bin/context-mode"),
		join(homedir(), "Library/pnpm/context-mode"),
		join(homedir(), ".local/share/pnpm/context-mode")
	];
	for (const p of probes) if (existsSync(p)) return p;
	try {
		const nvmBin = join(homedir(), ".nvm/versions/node");
		if (existsSync(nvmBin)) {
			const dirs = execSync(`ls -d ${nvmBin}/*/bin/context-mode 2>/dev/null`, {
				encoding: "utf-8",
				timeout: 5e3
			}).trim().split("\n").filter(Boolean);
			if (dirs.length) return dirs[0];
		}
	} catch {}
	return null;
}
//#endregion
//#region src/host/dsh-formatter.ts
/** context-mode 工具前缀（跳过 sandbox 自身工具，防循环） */
function isContextModeTool(name) {
	if (!name) return false;
	return name.startsWith("mcp__context-mode__") || name.startsWith("mcp__plugin_context-mode");
}
/**
* 把 context-mode 返回的 guidance 字符串包装成 DSH 合法 UserMessage。
* DSH 的 acceptContext 把 additionalContexts 元素直接塞进 agent/inbox/spliced.inserted，
* 不做包装；裸字符串会触发加载时 "requires message objects" 校验失败。
* 字符串才包装，已是对象则透传（防未来 decision 形态变化）。
*/
function wrapContextMessage(context) {
	if (typeof context === "string") return {
		id: `cm-bridge-${randomUUID()}`,
		role: "user",
		content: [{
			type: "text",
			text: context
		}],
		source: {
			kind: "plugin:dsh-context-mode-adapter",
			form: "notice"
		}
	};
	if (context !== null && typeof context === "object") return context;
	return {
		id: `cm-bridge-${randomUUID()}`,
		role: "user",
		content: [],
		source: {
			kind: "plugin:dsh-context-mode-adapter",
			form: "notice"
		}
	};
}
/**
* C9(2026-10-09): context-mode 的 tool-naming 平台表(TOOL_PREFIXES)没有 'dsh' 条目,
* getToolName 对未知平台 fallback 到 claude-code 约定,把 guidance/reason/redirect 文案里的
* 工具名生成为 mcp__plugin_context-mode_context-mode__ctx_* / mcp__context-mode__ctx_*。
* embedded 注册名是裸名 ctx_*,文案必须归一回裸名,否则模型照文案调用会找不到工具。
* decision 是纯数据对象(normalized decision),JSON 序列化替换后重建,一次覆盖
* additionalContext / reason / updatedInput / redirectMeta 里的所有字符串。
*/
function normalizeDecisionToolNaming(decision) {
	try {
		const json = JSON.stringify(decision).replace(/mcp__plugin_context-mode_context-mode__/g, "").replace(/mcp__context-mode__/g, "");
		return JSON.parse(json);
	} catch {
		return decision;
	}
}
/** applyDecision: routePreToolUse decision → DSH tools/execute 行为 */
async function applyDecision(exec, decision, next) {
	if (!decision) return next();
	decision = normalizeDecisionToolNaming(decision);
	switch (decision.action) {
		case "modify":
			if (decision.updatedInput) {
				if (exec.input !== void 0) exec.input = {
					...exec.input,
					...decision.updatedInput
				};
				else if (exec.arguments !== void 0) exec.arguments = {
					...exec.arguments,
					...decision.updatedInput
				};
			}
			return next();
		case "deny": return {
			kind: "block",
			feedback: decision.reason ?? "blocked by context-mode"
		};
		case "context": {
			const downstream = await next();
			const extra = decision.additionalContext;
			if (extra) return {
				...downstream,
				additionalContexts: [wrapContextMessage(extra), ...downstream.additionalContexts ?? []]
			};
			return downstream;
		}
		case "ask": return next();
		default: return next();
	}
}
//#endregion
//#region src/host/dsh-block.ts
/**
* dsh-context-mode-adapter — DSH 版 routing block 构造(spec C2)
*
* createRoutingBlock 产出官方 <context_window_protection> block,其 <file_writing_policy>
* 按 Claude Code 场景写("沙箱写盘不持久"),对 DSH 不成立(实测 ④:ctx_execute 沙箱写盘持久)。
* 仅正则替换该段为 DSH 版,其余段落(priority_instructions/tool_selection_hierarchy 等)
* 保持官方原文,随 context-mode 升级自动跟进。
*/
const DSH_FILE_WRITING_POLICY = `<file_writing_policy>
  Deliverable file changes MUST go through the native read/edit/write tools
  (version-guarded and audited by the harness). ctx_execute / ctx_execute_file
  are for reading and analysis. Sandbox subprocess writes DO persist on DSH,
  but their outputs are intermediate artifacts only - final deliverables must
  land via the write/edit tools.
</file_writing_policy>`;
/**
* C8:按启用集合过滤 block 引导行 —— 行内引用的 ctx_* 全部启用才保留。
* 过滤先行,DSH file_writing_policy 替换在后(该段是行为约束,不参与过滤)。
*/
function filterBlockForEnabled(block, enabled) {
	return block.split("\n").filter((line) => {
		const refs = line.match(/ctx_[a-z_]+/g);
		if (!refs) return true;
		return refs.every((n) => enabled.has(n));
	}).join("\n").replace(/\n{3,}/g, "\n\n");
}
/** 官方 block → DSH 化(启用集过滤 + 替换 file_writing_policy 段);失败返回 null(best-effort) */
function buildDshRoutingBlock(createRoutingBlock, toolNamer, enabledTools) {
	try {
		const block = createRoutingBlock(toolNamer, {
			includeCommands: !enabledTools || [
				"ctx_stats",
				"ctx_doctor",
				"ctx_upgrade",
				"ctx_purge"
			].every((t) => enabledTools.has(t)),
			toolSearchBootstrap: false
		});
		if (typeof block !== "string" || !block) return null;
		return (enabledTools ? filterBlockForEnabled(block, enabledTools) : block).replace(/<file_writing_policy>[\s\S]*?<\/file_writing_policy>/, DSH_FILE_WRITING_POLICY);
	} catch {
		return null;
	}
}
//#endregion
//#region src/host/session-bridge.ts
/**
* dsh-context-mode-adapter — 官方 SessionDB 薄层(重写,spec C1/C3)
*
* 对齐 context-mode 官方 adapter 的会话记忆链路(参照 openclaw/plugin.ts、hooks/userpromptsubmit.mjs):
*  - ensureSession(sid):         会话首见初始化(cleanupOldSessions 一次 + 旧 bridge_events 表清理)
*  - logPostToolUse(exec, res):  PostToolUse → extractEvents → session_events
*  - snapshotSession(sid):       compaction/start → buildResumeSnapshot + upsertResume
*  - claimResume(sid):           会话首见 resume 领取(跨会话走 claimLatestUnconsumedResume,同会话自查)
*
* 实测结论(2026-10-08,详见 spec):
*  - insertEvent 内置 SHA256 dedup(同 session+type+data_hash 窗口内查重),幂等,上层无需自行查重
*  - resolveSessionDbPath({projectDir, sessionsDir}) 适配 DSH 会话目录(sessionsDir 必传)
*  - claimLatestUnconsumedResume 只认 session_id != sid(跨会话语义),同会话 compaction 需自查 resume 表
*  - 磁盘无现存 bridge_events 文件,DROP IF EXISTS 幂等防御即可
*
* 模块路径一律动态解析(resolveContextModePath),import 失败 → getSessionBridge 返回 null 降级为现状。
* best-effort:任何失败静默,不阻断主流程。
*/
const CMP_FALLBACK$1 = resolve(homedir(), ".npm-global/lib/node_modules/context-mode");
function resolveContextModePath$1() {
	try {
		return createRequire(import.meta.url).resolve("context-mode/package.json").replace(/\/package\.json$/, "");
	} catch {
		return CMP_FALLBACK$1;
	}
}
const CMP = resolveContextModePath$1();
/** cwd → DSH 会话目录(~/.dsh/sessions/--Users-claw-...--,'/'→'-' 且首尾各留一个 '-') */
function dshSessionsDir() {
	const munged = "--" + process.cwd().split("/").filter(Boolean).join("-") + "--";
	return resolve(homedir(), ".dsh/sessions", munged);
}
/**
* 0.2.0 事件 payload 的 agent.session 是 Session 对象(带 .id),不是字符串。
* 直接把对象当 session_id 绑进 node:sqlite 会报 "Unknown named parameter"(对象被当作具名参数)。
* 统一解析:字符串原样;对象取 .id;无法解析返回空串由调用方兜底。
*/
function resolveSessionId(agent) {
	if (agent === null || typeof agent !== "object") return "";
	const s = agent.session;
	if (typeof s === "string") return s;
	if (s !== null && typeof s === "object") {
		const id = s.id;
		if (typeof id === "string" && id) return id;
		return "default";
	}
	return "";
}
let cached$1 = null;
/** 懒加载单例;import/初始化失败返回 null(调用方降级为现状) */
function getSessionBridge() {
	cached$1 ??= initBridge();
	return cached$1;
}
async function initBridge() {
	try {
		const dbMod = await import(resolve(CMP, "build/session/db.js"));
		const exMod = await import(resolve(CMP, "build/session/extract.js"));
		const snMod = await import(resolve(CMP, "build/session/snapshot.js"));
		const { SessionDB, resolveSessionDbPath } = dbMod;
		if (typeof SessionDB !== "function" || typeof resolveSessionDbPath !== "function") return null;
		if (typeof exMod.extractEvents !== "function") return null;
		if (typeof snMod.buildResumeSnapshot !== "function") return null;
		const sessionsDir = dshSessionsDir();
		mkdirSync(sessionsDir, { recursive: true });
		const db = new SessionDB({ dbPath: resolveSessionDbPath({
			projectDir: process.cwd(),
			sessionsDir
		}) });
		let sessionReady = false;
		return {
			ensureSession(_sessionId) {
				if (sessionReady) return;
				sessionReady = true;
				try {
					db.cleanupOldSessions?.(7);
				} catch {}
				try {
					db.db.exec("DROP TABLE IF EXISTS bridge_events");
				} catch {}
			},
			async logPostToolUse(exec, result) {
				try {
					const e = exec;
					const sid = resolveSessionId(e?.agent);
					if (!sid) return;
					const hookInput = {
						session_id: sid,
						tool_name: e?.name ?? "",
						tool_input: e?.input ?? e?.arguments ?? {},
						tool_response: result
					};
					for (const ev of exMod.extractEvents(hookInput) ?? []) db.insertEvent(sid, ev, "PostToolUse");
				} catch {}
			},
			snapshotSession(sessionId) {
				try {
					const events = db.getEvents(sessionId) ?? [];
					const stats = db.getSessionStats?.(sessionId);
					const compactCount = Number(stats?.compact_count ?? 0) + 1;
					const raw = snMod.buildResumeSnapshot(events, { compactCount });
					const snapshot = typeof raw === "string" ? raw : JSON.stringify(raw);
					db.upsertResume(sessionId, snapshot, events.length);
				} catch {}
			},
			claimResume(sessionId) {
				try {
					const row = db.claimLatestUnconsumedResume?.(sessionId);
					if (row?.snapshot) return String(row.snapshot);
					const own = db.db.prepare("SELECT snapshot FROM session_resume WHERE session_id = ? AND consumed = 0 ORDER BY created_at DESC, id DESC LIMIT 1").get(sessionId);
					if (own?.snapshot) {
						try {
							db.db.prepare("UPDATE session_resume SET consumed = 1 WHERE session_id = ? AND consumed = 0").run(sessionId);
						} catch {}
						return String(own.snapshot);
					}
					return null;
				} catch {
					return null;
				}
			},
			getEvents(sessionId) {
				try {
					return db.getEvents(sessionId) ?? [];
				} catch {
					return [];
				}
			}
		};
	} catch {
		return null;
	}
}
//#endregion
//#region src/host/embedded-tools.ts
/**
* dsh-context-mode-adapter — embedded 工具接入层(spec C4/C5)
*
* C4:设置 CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS=1 后 import context-mode 的 build/server.js:
*   - 模块顶层将 11 个 ctx_* 工具注册进导出的 REGISTERED_CTX_TOOLS(name/config/handler)
*   - 该 env 使其跳过进程级异常 handler 安装与 main()(stdio server 不启动,零冲突)
* C5:registerEmbeddedTools 把注册表条目适配为内核 defineTool 并经 ctx.tools.register
*   注册(无前缀 ctx_* 命名);被禁工具不注册(schema 级启停)。
*/
let cached = null;
let cachedPkgRoot = null;
/** 注册链诊断日志(console 进 /dev/null,落文件才可查) */
function diag(msg) {
	try {
		appendFileSync(resolve(homedir(), ".dsh/context-mode/adapter-register.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}\n`, { flag: "a" });
	} catch {}
}
/** 由 context-mode 的 bin 路径解析包根(向上找 name===context-mode 的 package.json) */
function resolvePackageRoot() {
	if (cachedPkgRoot) return cachedPkgRoot;
	try {
		const bin = detectContextModePath();
		if (!bin) return null;
		let dir = dirname(realpathSync(bin));
		for (let i = 0; i < 6; i++) {
			try {
				if (JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).name === "context-mode") {
					cachedPkgRoot = dir;
					return dir;
				}
			} catch {}
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	} catch {}
	return null;
}
/** C4:进程内获取 context-mode 工具注册表(单例;失败返回空数组 = 等价全关降级) */
async function getContextModeToolRegistry() {
	if (cached) return cached;
	try {
		const pkgRoot = resolvePackageRoot();
		if (!pkgRoot) {
			diag("registry: context-mode package root not found");
			cached = [];
			return cached;
		}
		process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
		const list = (await import(pathToFileURL(join(pkgRoot, "build", "server.js")).href))?.REGISTERED_CTX_TOOLS;
		cached = Array.isArray(list) ? list : [];
		diag(`registry: ${cached.length} tools from ${pkgRoot}`);
	} catch (e) {
		diag(`registry load FAILED: ${e instanceof Error ? e.message : e}`);
		cached = [];
	}
	return cached;
}
let defineToolFn;
/**
* 惰性解析内核 @deepseek-ai/dsh-tools(内核内部包,不在插件依赖树):
* ① 宿主模块上下文(内核加载插件时可能可解析)→ ② Electron app asar 内路径。
* 均不可得(如 verify 模拟环境)返回 null,注册桥整体降级跳过。
*/
/** verify 测试钩子:注入 stub defineTool(逻辑层验证;真内核由 electron probe 验证) */
let __defineToolOverride = null;
function __setDefineToolForTest(fn) {
	__defineToolOverride = fn;
}
function loadDefineTool() {
	if (__defineToolOverride) return __defineToolOverride;
	if (defineToolFn !== void 0) return defineToolFn;
	const candidates = [() => createRequire(import.meta.url)("@deepseek-ai/dsh-tools"), () => {
		const resPath = process.resourcesPath;
		const appAsar = resPath ? resolve(resPath, "app.asar") : "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
		return createRequire(join(appAsar, "dsh/node_modules/@deepseek-ai/dsh-tools/package.json"))("@deepseek-ai/dsh-tools");
	}];
	for (const [i, load] of candidates.entries()) try {
		const mod = load();
		if (typeof mod?.defineTool === "function") {
			const fn = mod.defineTool;
			defineToolFn = fn;
			diag(`defineTool resolved via candidate #${i}`);
			return fn;
		}
	} catch (e) {
		diag(`defineTool candidate #${i} failed: ${e instanceof Error ? e.message : e}`);
	}
	defineToolFn = null;
	return null;
}
/** zod 实例 → JSON Schema(用 context-mode 自带的 zod-to-json-schema;非 zod 输入原样返回 undefined) */
function zodToJsonSchema(inputSchema, pkgRoot) {
	if (!inputSchema || typeof inputSchema !== "object") return void 0;
	try {
		const z2jsMod = createRequire(join(pkgRoot, "package.json"))("zod-to-json-schema");
		const out = (z2jsMod.zodToJsonSchema ?? z2jsMod.default ?? z2jsMod)(inputSchema);
		return out && typeof out === "object" ? out : void 0;
	} catch {
		return;
	}
}
/** JSON Schema 属性 → defineTool DSL 值节点(allowRequired=false 的嵌套上下文不带 required) */
function jsonToValueSchema(v, allowRequired, required) {
	const node = {};
	const t = typeof v?.type === "string" ? v.type : void 0;
	if (t === "array") {
		node.type = "array";
		if (v.items) node.items = jsonToValueSchema(v.items, false, false);
	} else if (t === "object" && v.properties && typeof v.properties === "object") {
		node.type = "object";
		const props = {};
		for (const [k, sub] of Object.entries(v.properties)) props[k] = jsonToValueSchema(sub, false, false);
		node.properties = props;
		node.additionalProperties = v.additionalProperties === true;
	} else if (t === "string" || t === "number" || t === "integer" || t === "boolean" || t === "null") {
		node.type = t;
		if (Array.isArray(v.enum) && v.enum.length > 0) node.enum = v.enum;
		if (v.const !== void 0) node.const = v.const;
	} else node.type = "json";
	if (typeof v?.description === "string") node.description = v.description;
	if (allowRequired && required) node.required = true;
	return node;
}
/** MCP 工具的 JSON Schema → defineTool parameters(property-map DSL) */
function adaptParameters(jsonSchema) {
	const spec = {};
	const props = jsonSchema?.properties ?? {};
	const requiredSet = new Set(Array.isArray(jsonSchema?.required) ? jsonSchema.required : []);
	for (const [key, sub] of Object.entries(props)) spec[key] = jsonToValueSchema(sub, true, requiredSet.has(key));
	return spec;
}
/**
* MCP handler 返回({content:[...]}) → defineTool execute 约定的单 content block。
* DSH 直调 handler 不经过 MCP SDK 的 zod parse,inputSchema 的 .default() 不会应用
* (ctx_batch_execute 不传 concurrency 时 undefined 漏进 runPool → Math.max(1,undefined)=NaN
* → 0 worker → settled 空洞数组 → .status 崩溃,2026-10-09):有 zod schema 时先 parse,
* 应用默认值并校验;校验失败返回错误文本(模型可读后修正参数)。
*/
function adaptExecute(handler, inputSchema) {
	const parseArgs = (args) => {
		const schema = inputSchema;
		if (!schema || typeof schema.parse !== "function") return {
			ok: true,
			value: args
		};
		try {
			return {
				ok: true,
				value: schema.parse(args ?? {})
			};
		} catch (e) {
			const err = e;
			return {
				ok: false,
				message: Array.isArray(err?.issues) && err.issues.length > 0 ? err.issues.map((i) => `${Array.isArray(i?.path) ? i.path.join(".") : String(i?.path ?? "?")}: ${i?.message ?? "invalid"}`).join("; ") : e instanceof Error ? e.message : String(e)
			};
		}
	};
	return async (args) => {
		const parsed = parseArgs(args);
		if (!parsed.ok) return {
			type: "text",
			text: `Invalid arguments: ${parsed.message}`
		};
		const r = await handler(parsed.value);
		if (r && typeof r === "object" && typeof r.type === "string" && !Array.isArray(r.content)) return r;
		return {
			type: "text",
			text: (Array.isArray(r?.content) ? r.content : []).map((b) => typeof b?.text === "string" ? b.text : JSON.stringify(b ?? null)).join("\n")
		};
	};
}
/**
* C5:按启用集合把注册表条目注册进内核 ctx.tools。
* @param ctx 宿主插件上下文(需 ctx.tools.register)
* @param enabled 启用工具短名集合(ctx_* 无前缀)
* @returns disposer 列表(备用;当前 apply 时快照,不动态注销)
*/
function registerEmbeddedTools(ctx, enabled) {
	const disposers = [];
	if (cached === null) return disposers;
	const defineTool = __defineToolOverride ?? loadDefineTool();
	if (!defineTool) {
		console.warn("[dsh-context-mode-adapter] @deepseek-ai/dsh-tools unreachable, embedded tools skipped");
		return disposers;
	}
	const pkgRoot = resolvePackageRoot() ?? "";
	diag(`register: begin, cached=${cached.length}, enabled=${[...enabled].join(",")}`);
	for (const entry of cached) {
		if (!enabled.has(entry.name)) continue;
		const jsonSchema = zodToJsonSchema(entry.config?.inputSchema, pkgRoot);
		const tool = defineTool({
			name: entry.name,
			description: typeof entry.config?.description === "string" ? entry.config.description : void 0,
			parameters: adaptParameters(jsonSchema),
			execute: adaptExecute(entry.handler, entry.config?.inputSchema),
			output: {
				schema: { type: "json" },
				render: (_args, value) => {
					const v = value;
					return [{
						type: "text",
						text: typeof v?.text === "string" ? v.text : JSON.stringify(value ?? null)
					}];
				}
			}
		});
		try {
			disposers.push(ctx.tools.register(tool));
			diag(`register: ${entry.name} OK`);
		} catch (e) {
			diag(`register: ${entry.name} FAILED: ${e instanceof Error ? e.message : e}`);
		}
	}
	if (disposers.length > 0) try {
		const sentinel = resolve(process.platform === "win32" ? tmpdir() : "/tmp", `context-mode-mcp-ready-${process.pid}`);
		writeFileSync(sentinel, String(process.pid));
		process.once("exit", () => {
			try {
				unlinkSync(sentinel);
			} catch {}
		});
		diag(`register: mcp-ready sentinel written (pid ${process.pid})`);
	} catch (e) {
		diag(`register: sentinel write failed: ${e instanceof Error ? e.message : e}`);
	}
	return disposers;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.5/node_modules/@deepseek-ai/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Shared config references used by schema validators and plugin runtimes. */
const write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
	if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
	} finally {
		ancestors.delete(value);
	}
}
/**
* Create a detached reference containing an immutable copy of the supplied data.
* @param value - validated config data; class instances and functions are unsupported.
* @returns a reference whose value is updated only by its owning runtime.
*/
function createVolatile(value) {
	let current = snapshot(value);
	return Object.freeze({
		get: () => current,
		[write]: (value) => {
			current = value;
		}
	});
}
/**
* Identify references across ESM/CJS copies of the shared library.
* @param value - a parsed config value.
* @returns whether the value implements the shared reference protocol.
*/
function isVolatile(value) {
	return typeof value === "object" && value !== null && write in value;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/**
* Compare values recursively, treating two volatile references as equal regardless of value.
* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
* @param a - first value.
* @param b - second value.
* @param strict - whether to require strict data equality outside volatile references.
* @returns whether the values compare equal.
*/
function deepEqual(a, b, strict) {
	const ancestors = /* @__PURE__ */ new Set();
	function compare(a, b) {
		if (a === b) return true;
		if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
		if (!strict && isNullable(a) && isNullable(b)) return true;
		if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
		if (ancestors.has(a)) return false;
		function check(test, then) {
			return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
		}
		ancestors.add(a);
		try {
			return check(Array.isArray, (a, b) => {
				if (a.length !== b.length) return false;
				for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
				return true;
			}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
				...a,
				...b
			}).every((key) => compare(a[key], b[key])));
		} finally {
			ancestors.delete(a);
		}
	}
	return compare(a, b);
}
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+schemastery@3.18.4/node_modules/@deepseek-ai/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (isVolatile(value)) value = value.get();
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.volatile = function volatile() {
	if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
	return this.extra("volatile", true);
};
const resolvers = {};
const checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
	const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
	if (states.has(blocked)) return;
	states.add(blocked);
	seen.set(schema, states);
	if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
	const nested = blocked || !!schema.meta?.volatile;
	if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
	if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
	if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
	if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (!options[checkedVolatile]) {
		validateVolatileSchema(schema, options.path);
		options = {
			...options,
			[checkedVolatile]: true
		};
	}
	if (schema.meta?.volatile) {
		const inner = Schema(schema);
		inner.meta = {
			...schema.meta,
			volatile: false
		};
		const [value, adapted] = Schema.resolve(data, inner, options, strict);
		try {
			return [createVolatile(value), adapted];
		} catch (error) {
			throw new ValidationError(error instanceof Error ? error.message : String(error), options);
		}
	}
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
		validateVolatileSchema(schema.inner, options.path, true);
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region src/config.ts
/** C6:MCP 工具开关(字段名 → 工具短名,默认开启?);不常用工具默认关闭 */
const TOOL_TOGGLES = [
	{
		field: "ctxSearchEnabled",
		tool: "ctx_search",
		default: true
	},
	{
		field: "ctxExecuteEnabled",
		tool: "ctx_execute",
		default: true
	},
	{
		field: "ctxExecuteFileEnabled",
		tool: "ctx_execute_file",
		default: true
	},
	{
		field: "ctxBatchExecuteEnabled",
		tool: "ctx_batch_execute",
		default: true
	},
	{
		field: "ctxFetchAndIndexEnabled",
		tool: "ctx_fetch_and_index",
		default: true
	},
	{
		field: "ctxIndexEnabled",
		tool: "ctx_index",
		default: true
	},
	{
		field: "ctxStatsEnabled",
		tool: "ctx_stats",
		default: true
	},
	{
		field: "ctxDoctorEnabled",
		tool: "ctx_doctor",
		default: true
	},
	{
		field: "ctxInsightEnabled",
		tool: "ctx_insight",
		default: false
	},
	{
		field: "ctxUpgradeEnabled",
		tool: "ctx_upgrade",
		default: false
	},
	{
		field: "ctxPurgeEnabled",
		tool: "ctx_purge",
		default: false
	}
];
const Config = Schema.object({
	...Object.fromEntries(TOOL_TOGGLES.map(({ field, tool, default: d }) => [field, Schema.boolean().default(d).volatile().description(`启用 ${tool} 工具(关闭后不注册给 AI)`)])),
	presenceWindow: Schema.number().default(40).min(10).max(500).volatile().description("注入尾部节点:尾部 N 个节点内已有注入块则本轮不重复注入;约等于轮次对话(纯聊天约 15~20 轮,带工具约 4~6 轮,重度工具调用约 2~4 轮)")
});
/** volatile 字段解包:ref 取 .get() 实时值;原始 boolean(测试/直传)原样;非法回退默认。必须每次读取时调用,不能缓存结果 */
function unwrapBoolean(v, fallback) {
	if (v === void 0 || v === null) return fallback;
	if (typeof v === "object" && "get" in v) {
		const cur = v.get();
		return typeof cur === "boolean" ? cur : fallback;
	}
	return typeof v === "boolean" ? v : fallback;
}
/** volatile number 字段解包(同 unwrapBoolean 语义) */
function unwrapNumber(v, fallback) {
	if (v === void 0 || v === null) return fallback;
	if (typeof v === "object" && "get" in v) {
		const cur = v.get();
		return typeof cur === "number" && Number.isFinite(cur) ? cur : fallback;
	}
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
/** C2 注入参数:实时解析 presence 窗口(schema 校验之外再 clamp 一道,防手滑) */
function collectPresenceWindow(c) {
	const n = unwrapNumber((c ?? {}).presenceWindow, 40);
	return Math.min(500, Math.max(10, n));
}
/** C6/C8 共用:按当前配置(实时解包)解析启用的工具短名集合 */
function collectEnabledTools(c) {
	const enabled = /* @__PURE__ */ new Set();
	const bag = c ?? {};
	for (const { field, tool, default: d } of TOOL_TOGGLES) if (unwrapBoolean(bag[field], d)) enabled.add(tool);
	return enabled;
}
//#endregion
//#region src/host/index.ts
/**
* dsh-context-mode-adapter — host half
*
* 工具层：由 cordis.patch.yml 的 mcp-context-mode 行（dsh-mcp-client）接入 context-mode stdio MCP server，
*         暴露 11 个 mcp__context-mode__ctx_* 工具，本文件不负责工具注册。
* hook 层（C3）：本文件 apply() 订阅 DSH cordis 工具/会话事件，进程内 import context-mode 的 routing/session API：
*   - tools/execute (waterfall): PreToolUse 硬拦截（routePreToolUse → modify/deny/context）
*   - tools/post-execute (waterfall): PostToolUse 落库（best-effort）
*   - agent/pre-step (waterfall): SessionStart 注入 routing block（nudge）
*   - compaction/start (emit): PreCompact 快照（best-effort）
* detect route（C4）：注册 /api/dsh-context-mode-adapter/detect，供 client 只读 card 查询。
*
* 安全（C5，2026-10-08 实测）：routing.mjs Stage 1 readBashPolicies 在 DSH 无 settings.json 时
* fail-open 静默（无 [context-mode] WARNING 输出），security 模块正常加载，Bash 大文件调用
* 正确返回 action:"context" 引导。无需告警降级代码。
*/
const name = "dsh-context-mode-adapter";
const inject = ["tools"];
const DETECT_ROUTE = "/api/dsh-context-mode-adapter/detect";
const STORAGE_ROOT = "~/.dsh/context-mode";
const TOOL_TIMEOUT_MS = 6e4;
const CMP_FALLBACK = resolve(homedir(), ".npm-global/lib/node_modules/context-mode");
function resolveContextModePath() {
	try {
		return createRequire(import.meta.url).resolve("context-mode/package.json").replace(/\/package\.json$/, "");
	} catch {
		return CMP_FALLBACK;
	}
}
function apply(ctx, config) {
	const CMP = resolveContextModePath();
	getContextModeToolRegistry().then((tools) => {
		diag(`bootstrap: registry=${tools.length}, enabled=${[...collectEnabledTools(config)].join(",")}`);
		registerEmbeddedTools(ctx, collectEnabledTools(config));
	}).catch((e) => {
		diag(`bootstrap FAILED: ${e instanceof Error ? e.message : e}`);
	});
	let lastActiveSession = "";
	const seenSessions = /* @__PURE__ */ new Set();
	const compactedSessions = /* @__PURE__ */ new Set();
	let autoInjectionFn;
	const getAutoInjection = async () => {
		if (autoInjectionFn !== void 0) return autoInjectionFn;
		try {
			const m = await import(`${CMP}/hooks/auto-injection.mjs`);
			autoInjectionFn = typeof m.buildAutoInjection === "function" ? m.buildAutoInjection : null;
		} catch {
			autoInjectionFn = null;
		}
		return autoInjectionFn;
	};
	ctx.inject(["connection", "sessions"], (c) => {
		const connection = c.get("connection");
		const register = typeof connection?.fetch?.register === "function" ? connection.fetch.register.bind(connection.fetch) : void 0;
		if (register === void 0) return;
		c.effect(() => register({
			path: DETECT_ROUTE,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async () => {
				const contextModePath = detectContextModePath() ?? "";
				return Response.json({
					contextModePath,
					storageRoot: STORAGE_ROOT,
					toolCallTimeoutMs: TOOL_TIMEOUT_MS
				}, { headers: { "cache-control": "no-store" } });
			}
		}, "dsh-context-mode-adapter: detect route"));
	});
	let routingApi = null;
	const getRoutingApi = async () => {
		if (routingApi) return routingApi;
		try {
			const routing = await import(`${CMP}/hooks/core/routing.mjs`);
			const rb = await import(`${CMP}/hooks/routing-block.mjs`);
			routingApi = {
				routePreToolUse: routing.routePreToolUse,
				createRoutingBlock: rb.createRoutingBlock
			};
		} catch {
			routingApi = null;
		}
		return routingApi;
	};
	const shortToolName = (name) => {
		if (!name) return null;
		const bare = name.startsWith("mcp__context-mode__") ? name.slice(19) : name.startsWith("mcp__plugin_context-mode") ? name.replace(/^mcp__plugin_context-mode__?/, "") : name;
		return bare.startsWith("ctx_") ? bare : null;
	};
	ctx.on("tools/execute", async (exec, next) => {
		const short = shortToolName(exec.name);
		if (short) {
			if (!collectEnabledTools(config).has(short)) return {
				kind: "block",
				feedback: `${short} 已在设置中禁用`
			};
		}
		if (isContextModeTool(exec.name)) return next();
		const api = await getRoutingApi();
		if (!api) return next();
		const toolInput = exec.input ?? exec.arguments ?? {};
		const sessionId = resolveSessionId(exec?.agent) || "unknown";
		const projectDir = process.cwd();
		let decision = null;
		try {
			const raw = api.routePreToolUse(exec.name, toolInput, projectDir, "dsh", sessionId);
			decision = await raw ?? raw;
		} catch {
			return next();
		}
		return applyDecision(exec, decision, next);
	});
	ctx.on("tools/post-execute", async (exec, _result, next) => {
		const downstream = await next();
		try {
			await (await getSessionBridge())?.logPostToolUse(exec, _result);
		} catch {}
		return downstream;
	});
	ctx.on("agent/pre-step", async (payload, next) => {
		const downstream = await next();
		const sid = resolveSessionId(payload?.agent) || "default";
		lastActiveSession = sid;
		const claimed = Array.isArray(payload?.messages) ? payload.messages : [];
		const contexts = [];
		const firstSeen = !seenSessions.has(sid);
		const justCompacted = compactedSessions.has(sid);
		if (firstSeen || justCompacted) {
			if (firstSeen) seenSessions.add(sid);
			if (justCompacted) compactedSessions.delete(sid);
			try {
				const bridge = await getSessionBridge();
				const snap = bridge?.claimResume(sid);
				if (snap) {
					contexts.push(wrapContextMessage(snap));
					if (!snap.includes("<session_state")) {
						const events = bridge?.getEvents(sid) ?? [];
						if (events.length > 0) {
							const autoText = (await getAutoInjection())?.(events);
							if (autoText) contexts.push(wrapContextMessage(autoText));
						}
					}
				}
			} catch {}
		}
		try {
			(await getSessionBridge())?.ensureSession(sid);
		} catch {}
		if (isUserTurnStart(payload?.messages) && !hasRecentRoutingBlock(payload?.agent, payload?.messages, collectPresenceWindow(config))) {
			const api = await getRoutingApi();
			if (api) try {
				const toolNamer = (name) => name;
				const block = buildDshRoutingBlock(api.createRoutingBlock, toolNamer, collectEnabledTools(config));
				if (block) contexts.push(wrapContextMessage(block));
			} catch {}
		}
		if (contexts.length > 0 && downstream?.kind !== "reject" && Array.isArray(downstream?.messages)) {
			const at = downstream.messages.findLastIndex((m) => claimed.includes(m)) + 1;
			return {
				...downstream,
				messages: downstream.messages.toSpliced(at, 0, ...contexts)
			};
		}
		return downstream;
	});
	ctx.on("compaction/start", async (payload) => {
		try {
			const bridge = await getSessionBridge();
			const sid = resolveSessionId(payload?.agent) || lastActiveSession || "default";
			bridge?.snapshotSession(sid);
			compactedSessions.add(sid);
		} catch {}
	});
}
/** 消息对象 → 文本(content: string 或 [{type:'text',text}] 数组) */
function messageText(m) {
	const mm = m;
	if (!mm || typeof mm !== "object") return "";
	const c = mm.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => p?.type === "text" ? String(p?.text ?? "") : "").filter(Boolean).join("\n");
	return "";
}
/**
* C2: 尾部窗口内是否已有本插件 routing block(presence 检测,保证 compaction 后自动重现)。
* 2026-10-09 修正:内核 pre-step 的 payload.messages 是 inbox.claim() 取出的本轮新输入
* (消费性取出,不含会话历史),旧实现扫它永远找不到上一轮注入的 block → 每个用户轮次重复注入。
* 改为优先扫 agent.session 持久化 surface(user/message 事件;compaction 裁剪 surface 后自动
* 重现);session 不可读时退回 payload 扫描兜底。
* 2026-10-09 设置化:窗口大小由 presenceWindow 设置注入(默认 40,volatile 即改即生效)。
*/
function hasRecentRoutingBlock(agent, messages, windowSize = 40) {
	const sid = resolveSessionId(agent) || "default";
	const session = agent?.session;
	if (session && typeof session.eventAt === "function" && Array.isArray(session.surface?.nodes)) {
		const window = session.surface.nodes.slice(-windowSize);
		const events = window.map((seq) => session.eventAt(seq));
		const hit = events.some((ev) => {
			if (ev?.type !== "user/message") return false;
			const d = ev.data;
			return messageText(d?.message ?? d).includes("<context_window_protection>");
		});
		diag(`presence: sid=${sid} surface path window=${window.length} userMsg=${events.filter((ev) => ev?.type === "user/message").length} hit=${hit}`);
		return hit;
	}
	diag(`presence: sid=${sid} FALLBACK payload path session=${session ? typeof session : "none"} eventAt=${session ? typeof session.eventAt : "n/a"} nodes=${session ? typeof session.surface?.nodes : "n/a"}`);
	if (!Array.isArray(messages)) return false;
	return messages.slice(-windowSize).some((m) => messageText(m).includes("<context_window_protection>"));
}
/**
* C2 轮次判定:本 step 是否由新的用户文本输入触发。
* 用户消息提交 → messages 尾部即非 synthetic 的 user 文本消息,计一轮;
* agent loop 的工具续跑 step(尾部是 tool 结果/assistant 回复)与本插件的 synthetic 注入都不计。
*/
function isUserTurnStart(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return false;
	const last = messages[messages.length - 1];
	if (!last || typeof last !== "object") return false;
	if (last.role && last.role !== "user") return false;
	if (last.source?.kind && String(last.source.kind).startsWith("plugin:")) return false;
	const c = last.content;
	if (typeof c === "string") return c.length > 0;
	if (Array.isArray(c)) return c.length > 0 && c.every((p) => p?.type === "text" && String(p?.text ?? "").length > 0);
	return false;
}
//#endregion
export { Config, __setDefineToolForTest, apply, getContextModeToolRegistry, inject, name, registerEmbeddedTools };
