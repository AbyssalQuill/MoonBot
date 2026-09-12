// 修补安装目录 dsh-client-ui-conversation/lib/client.js：
// 给附件注册表加 revision 计数，让 InputBar 在外部（describe-image 钩子）
// 释放图片后立即重新解析附件列表，解决"图片发送后残留输入框"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 目标文件从当前用户环境推导（argv[2] 可覆盖），不写死某个用户名/盘符。
const file = process.argv[2] || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'backend', 'node_modules',
  '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js',
);
let t = fs.readFileSync(file, 'utf8');
let applied = 0;

function apply(oldStr, newStr, label) {
  if (!t.includes(oldStr)) {
    console.error(`✗ 未找到: ${label}`);
    process.exitCode = 1;
    return;
  }
  t = t.replace(oldStr, newStr);
  applied += 1;
  console.log(`✓ ${label}`);
}

// ── 补丁 1: ConversationController 类字段 + bump 方法 ──
apply(
  `draftAttachments = /* @__PURE__ */ new Map();
			imageUrls = /* @__PURE__ */ new Map();`,
  `draftAttachments = /* @__PURE__ */ new Map();
			imageUrls = /* @__PURE__ */ new Map();
			/** Invalidation source for the draft-attachment registry (bumped on any mutation). */
			draftRevision = /* @__PURE__ */ (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(0);
			/** Read the draft-attachment registry revision (subscribed by the composer rail). */
			registryRevision() {
				return this.draftRevision;
			}
			bumpDraftRevision() {
				this.draftRevision.set(this.draftRevision.getSnapshot() + 1);
			}`,
  '补丁1: draftRevision 字段'
);

// ── 补丁 2a: createDraftImages bump ──
apply(
  `createDraftImages(files) {
				for (const file of files) imageMediaType(file.type);
				return files.map((file) => {
					const attachment = browserDraftAttachment(file);
					this.draftAttachments.set(attachment.id, attachment);
					this.createdImageUrls.add(attachment.previewUrl);
					return attachment;
				});
			}`,
  `createDraftImages(files) {
				for (const file of files) imageMediaType(file.type);
				const images = files.map((file) => {
					const attachment = browserDraftAttachment(file);
					this.draftAttachments.set(attachment.id, attachment);
					this.createdImageUrls.add(attachment.previewUrl);
					return attachment;
				});
				if (images.length > 0) this.bumpDraftRevision();
				return images;
			}`,
  '补丁2a: createDraftImages bump'
);

// ── 补丁 2b: releaseDraftImage bump ──
apply(
  `releaseDraftImage(id) {
				const attachment = this.draftAttachments.get(id);
				if (attachment === void 0) return;
				this.draftAttachments.delete(id);
				this.createdImageUrls.delete(attachment.previewUrl);
				revokePreview(attachment.previewUrl);
			}`,
  `releaseDraftImage(id) {
				const attachment = this.draftAttachments.get(id);
				if (attachment === void 0) return;
				this.draftAttachments.delete(id);
				this.createdImageUrls.delete(attachment.previewUrl);
				revokePreview(attachment.previewUrl);
				this.bumpDraftRevision();
			}`,
  '补丁2b: releaseDraftImage bump'
);

// ── 补丁 3a: 无 session hooks 注入 ──
apply(
  `hooks: {
							notices: ABSENT_NOTICES,
							lexicon: ABSENT_LEXICON,
							menuLauncher: ABSENT_MENU_LAUNCHER
						}
					};
					const conversation = concreteConversation(ctx);`,
  `hooks: {
							notices: ABSENT_NOTICES,
							lexicon: ABSENT_LEXICON,
							menuLauncher: ABSENT_MENU_LAUNCHER,
							draftImagesRevision: ABSENT_DRAFT_REVISION
						}
					};
					const conversation = concreteConversation(ctx);`,
  '补丁3a: 无session hooks'
);

// ── 补丁 3b: 有 session hooks 注入 ──
apply(
  `hooks: {
							notices: shell.notices,
							lexicon: shell.lexicon,
							menuLauncher: inputTriggers?.launcher ?? ABSENT_MENU_LAUNCHER
						}`,
  `hooks: {
							notices: shell.notices,
							lexicon: shell.lexicon,
							menuLauncher: inputTriggers?.launcher ?? ABSENT_MENU_LAUNCHER,
							draftImagesRevision: conversation.registryRevision()
						}`,
  '补丁3b: 有session hooks'
);

// ── 补丁 4: ABSENT_DRAFT_REVISION 常量定义（放在 ABSENT_MENU_LAUNCHER 附近） ──
// 先找 ABSENT_MENU_LAUNCHER 定义
const absentMatch = t.match(/const ABSENT_MENU_LAUNCHER = \{\s*\n\s*getSnapshot: \(\) => null,\s*\n\s*subscribe: \(\) => \(\) => \{\}\s*\n\s*\};/);
if (absentMatch) {
  const insert = `${absentMatch[0]}\n\t\tconst ABSENT_DRAFT_REVISION = {\n\t\t\tgetSnapshot: () => 0,\n\t\t\tsubscribe: () => () => {}\n\t\t};`;
  t = t.replace(absentMatch[0], insert);
  applied += 1;
  console.log('✓ 补丁4: ABSENT_DRAFT_REVISION 常量');
} else {
  console.error('✗ 未找到: ABSENT_MENU_LAUNCHER 定义位置');
  process.exitCode = 1;
}

// ── 补丁 5: InputBar 订阅 revision + memo 依赖 ──
apply(
  `const attachments = (0, react.useMemo)(() => input === void 0 || draftImages === void 0 ? [] : draftImages(input.imageIds), [draftImages, input?.imageIds]);`,
  `const draftImagesRevision = useDraftImagesRevision((s) => s);
			const attachments = (0, react.useMemo)(() => input === void 0 || draftImages === void 0 ? [] : draftImages(input.imageIds), [draftImages, input?.imageIds, draftImagesRevision]);`,
  '补丁5: InputBar memo 依赖'
);

// ── 补丁 6: InputBar 函数参数加 useDraftImagesRevision ──
apply(
  `function InputBar({ useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages, resolveSubmitMode, toggleCommandMenu, stop, command, t, renderSlot, useNotices, useLexicon, useMenuLauncher, useProjection,`,
  `function InputBar({ useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages, resolveSubmitMode, toggleCommandMenu, stop, command, t, renderSlot, useNotices, useLexicon, useMenuLauncher, useDraftImagesRevision, useProjection,`,
  '补丁6: InputBar 参数'
);

fs.writeFileSync(file, t, 'utf8');
console.log(`\n完成: 应用 ${applied} 处补丁`);
process.exit(process.exitCode ?? 0);
