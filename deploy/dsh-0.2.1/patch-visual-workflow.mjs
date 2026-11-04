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

if (source.includes(after)) process.exit(0)
if (source.split(before).length !== 2) throw new Error('Expected Visual Workflow v0.10.3 client registration')
source = source.replace(before, after)
await writeFile(file, source)
