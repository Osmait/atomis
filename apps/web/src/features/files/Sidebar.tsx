import type React from "react";

import { FileTree } from "./FileTree.js";
import type { useProjectFiles } from "./useProjectFiles.js";

type Project = ReturnType<typeof useProjectFiles>;

interface SidebarProps {
	/** The file hook itself: the draft, the collapse state and the actions. */
	project: Project;
	activePath: string;
	activeIsEntry: boolean;
	rows: React.ComponentProps<typeof FileTree>["rows"];
	failsByFile: React.ComponentProps<typeof FileTree>["failsByFile"];
	treeSel: React.ComponentProps<typeof FileTree>["treeSel"];
	focused: boolean;
	revealKey: string;
	scratch: boolean;
	workspaceName: string;
	onSelect: (path: string) => void;
	onToggleFolder: (path: string) => void;
	onHideTree: () => void;
	onLoadDemo: () => void;
	onClearWorkspace: () => void;
	onSwitchWorkspace: () => void;
}

/**
 * The file tree panel.
 *
 * Half of what the tree needs is the file hook's own state — the inline
 * rename draft, whether src is collapsed, the create and delete actions —
 * so it takes the hook rather than fifteen pieces of it, and the shell is
 * left passing only what the shell knows.
 */
export function Sidebar(props: SidebarProps): React.JSX.Element {
	const { project, activePath } = props;
	return (
		<FileTree
			activeIsEntry={props.activeIsEntry}
			activePath={activePath}
			draft={project.treeDraft}
			draftInvalid={project.treeDraftInvalid}
			draftValue={project.treeDraftValue}
			failsByFile={props.failsByFile}
			focused={props.focused}
			onClearWorkspace={props.onClearWorkspace}
			onCreateFile={project.createFile}
			onCreateFolder={project.createFolder}
			onDeleteActive={() => project.deleteFile(activePath)}
			onDraftCancel={() => project.setTreeDraft(undefined)}
			onDraftChange={(value) => {
				project.setTreeDraftInvalid(false);
				project.setTreeDraftValue(value);
			}}
			onDraftCommit={project.commitTreeDraft}
			onHideTree={props.onHideTree}
			onLoadDemo={props.onLoadDemo}
			onOpenContextMenu={project.setTreeContextMenu}
			onRenameActive={() => project.renameFile(activePath)}
			onSelect={props.onSelect}
			onSwitchWorkspace={props.onSwitchWorkspace}
			onToggleFolder={props.onToggleFolder}
			onToggleSrc={() => project.setSrcCollapsed((previous) => !previous)}
			revealKey={props.revealKey}
			rows={props.rows}
			scratch={props.scratch}
			srcCollapsed={project.srcCollapsed}
			treeSel={props.treeSel}
			workspaceName={props.workspaceName}
		/>
	);
}
