import { readFile, writeFile } from 'node:fs/promises'

const file = process.argv[2] ?? '/opt/dsh-runtime/node_modules/dsh-visual-workflow/lib/client.js'
let source = await readFile(file, 'utf8')

const before = `			setWorkbenchOpenHandler(createWorkbenchOpener(ctx));
			ctx.effect?.(() => () => setWorkbenchOpenHandler(null), "visual-workflow: entry handler");
			const registerSlots = (scoped) => {
				const slots = scoped.get?.("slots");
				const tabs = scoped.get?.("sidebarRightTabs");
				if (!slots || !tabs) return;
				scoped.effect?.(() => registerWorkbenchTabType(tabs), "visual-workflow: workbench tab type");
				scoped.effect?.(() => injectWorkbenchTabBody(slots), "visual-workflow: workbench tab body");
				scoped.effect?.(() => injectWorkbenchEntry(slots), "visual-workflow: sidebar entry");
			};
			if (typeof ctx.inject === "function") ctx.inject(["slots", "sidebarRightTabs"], registerSlots);
			else registerSlots(ctx);`

// Use the same global panel slots as the rc3 automation task manager.
const after = `			const registerSlots = (scoped) => {
				const slots = scoped.get?.("slots");
				if (!slots) return;
				slots.inject("sidebar.panellist", () => slots.register({
					name: "sidebar.panellist",
					id: WORKBENCH_TAB_ID,
					order: 11,
					label: () => getWorkbenchDict().workflows
				}, ({ size = 18 }) => (0, react_jsx_runtime.jsx)("svg", {
					viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": true,
					children: (0, react_jsx_runtime.jsx)("path", {
						fill: "currentColor", d: "M3 5h18v2H3zm0 6h18v2H3zm0 6h12v2H3z"
					})
				})));
				slots.inject("main", () => slots.register({
					name: "main", key: WORKBENCH_TAB_ID
				}, WorkbenchTabBody));
			};
			if (typeof ctx.inject === "function") ctx.inject(["slots"], registerSlots);
			else registerSlots(ctx);`

function replace(before, after) {
  if (source.includes(after)) return
  if (source.split(before).length !== 2) throw new Error('Expected Visual Workflow v0.10.3 client target')
  source = source.replace(before, after)
}

replace(before, after)
replace('const workspacePicker = (0, react.useMemo)(() => createWorkspacePicker(ctx), [ctx]);', `const slots = ctx.get?.("slots");
			const directoryEntry = () => slots?.entries("sidebar.workspaces.directoryFlow")?.[0];
			const [directoryRequest, setDirectoryRequest] = (0, react.useState)(null);
			const pendingDirectory = (0, react.useRef)(null);
			const settleDirectory = (value, error) => {
				const pending = pendingDirectory.current;
				pendingDirectory.current = null;
				setDirectoryRequest(null);
				if (error) pending?.reject(error);
				else pending?.resolve(value);
			};
			(0, react.useEffect)(() => () => {
				pendingDirectory.current?.resolve(null);
				pendingDirectory.current = null;
			}, []);
			const workspacePicker = {
				available: () => Boolean(directoryEntry()?.component),
				pick: () => new Promise((resolve, reject) => {
					const entry = directoryEntry();
					if (!entry?.component) return reject(new Error("网页目录浏览器尚未就绪"));
					if (pendingDirectory.current) return resolve(null);
					pendingDirectory.current = { resolve, reject };
					setDirectoryRequest(entry);
				})
			};`)
replace(`return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Studio, {
				language: detectLanguage(ctx.get?.("locale") ?? ctx.locale),
				t,
				sessionId,
				onRunImmersive: shrinkOfficialSidebarIfFullscreen,
				workspacePicker,
				filePathResolver
			});`, `return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				(0, react_jsx_runtime.jsx)(Studio, {
					language: detectLanguage(ctx.get?.("locale") ?? ctx.locale),
					t, sessionId, onRunImmersive: shrinkOfficialSidebarIfFullscreen, workspacePicker, filePathResolver
				}),
				directoryRequest && (0, react_jsx_runtime.jsx)(directoryRequest.component, {
					...directoryRequest.options.inject(),
					open: true,
					busy: false,
					onPicked: path => settleDirectory(path),
					onCancel: () => settleDirectory(null),
					onError: message => settleDirectory(null, new Error(message))
				})
			] });`)
await writeFile(file, source)
