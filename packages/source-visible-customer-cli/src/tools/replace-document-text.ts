import chalk from '../colors.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isSensitiveProjectPath,
  normalizeProjectRelativePath,
} from '../artifact-policy.js';
import { readCliAuthConfig } from '../api/auth.js';
import type { AuthorizedServerConfig } from '../api/http.js';
import { resolveProjectPath, writeProjectFileBuffer } from '../patcher.js';
import { repairFilePath, suggestClosestPath } from './path-suggest.js';
import { isTuiMode } from '../runtime-mode.js';
import { ensurePermission } from '../permissions.js';
import { getCurrentFileHash } from '../session-safety.js';
import type { ToolContext, ToolResponse } from './types.js';

interface DocumentReplacement {
  oldText: string;
  newText: string;
}

function normalizeReplacements(value: unknown): DocumentReplacement[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): DocumentReplacement | null => {
      if (!item || typeof item !== 'object') return null;
      const entry = item as Record<string, unknown>;
      const oldText = String(entry.oldText ?? entry.old_text ?? '');
      const newText = String(entry.newText ?? entry.new_text ?? '');
      if (!oldText) return null;
      return { oldText, newText };
    })
    .filter(Boolean) as DocumentReplacement[];
}

function relativeEditablePath(rootDir: string, rawPath: string): string | null {
  const resolvedPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(rootDir, rawPath);
  const projectPath = normalizeProjectRelativePath(rootDir, resolvedPath);
  if (!projectPath || isSensitiveProjectPath(projectPath)) return null;
  return projectPath.split(path.sep).join('/');
}

function renderPreview(filePath: string, preview: string): void {
  if (isTuiMode()) return;
  console.log(chalk.bold(`\n  Document text replacement preview for ${filePath}:`));
  for (const line of preview.split('\n')) {
    if (line.startsWith('+')) {
      console.log(chalk.green(line));
    } else if (line.startsWith('-')) {
      console.log(chalk.red(line));
    } else if (line.startsWith('@@')) {
      console.log(chalk.cyan(line));
    } else {
      console.log(chalk.dim(line));
    }
  }
  console.log();
}

async function replaceDocumentTextOnServer(
  config: AuthorizedServerConfig,
  fileName: string,
  fileData: Buffer,
  replacements: DocumentReplacement[],
  replaceAll: boolean,
  validate: boolean,
): Promise<ToolResponse> {
  const response = await globalThis.fetch(
    `${config.serverUrl.replace(/\/+$/, '')}/v1/document/replace-text`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileName,
        fileData: fileData.toString('base64'),
        replacements,
        replaceAll,
        validate,
      }),
    },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      error: `Server document edit failed: ${data?.error?.message ?? response.status}`,
    };
  }
  return data as ToolResponse;
}

export async function replaceDocumentText(
  context: ToolContext,
  args: {
    filePath?: string;
    file_path?: string;
    outputPath?: string;
    output_path?: string;
    replacements?: unknown;
    replaceAll?: boolean;
    replace_all?: boolean;
    validate?: boolean;
    dryRun?: boolean;
  },
): Promise<ToolResponse> {
  const sourceRaw = repairFilePath(
    context.rootDir,
    String(args.filePath ?? args.file_path ?? '').trim(),
  );
  if (!sourceRaw) {
    return { ok: false, error: 'filePath is required' };
  }
  const sourcePath = relativeEditablePath(context.rootDir, sourceRaw);
  if (!sourcePath) {
    return {
      ok: false,
      error: 'replace_document_text can only edit permitted files inside the project root.',
      failureCategory: 'permission_denied',
    };
  }
  if (path.extname(sourcePath).toLowerCase() !== '.docx') {
    return {
      ok: false,
      error: 'replace_document_text only supports .docx files.',
      failureCategory: 'invalid_argument',
    };
  }

  // outputPath is a write target, not an existing input, so it must NOT be
  // path-repaired: fold-match could redirect a "create Review '24.docx" onto an
  // existing Review ’24.docx and overwrite it. The executor mirrors this by not
  // repairing the snapshot path when an outputPath is present.
  const outputRaw = String(args.outputPath ?? args.output_path ?? '').trim();
  const targetPath = outputRaw
    ? relativeEditablePath(context.rootDir, outputRaw)
    : sourcePath;
  if (!targetPath) {
    return {
      ok: false,
      error: 'outputPath must be inside the project root.',
      failureCategory: 'permission_denied',
    };
  }
  if (path.extname(targetPath).toLowerCase() !== '.docx') {
    return {
      ok: false,
      error: 'outputPath must end with .docx.',
      failureCategory: 'invalid_argument',
    };
  }

  const replacements = normalizeReplacements(args.replacements);
  if (!replacements.length) {
    return {
      ok: false,
      error: 'replacements must include at least one { oldText, newText } item.',
      failureCategory: 'missing_required_argument',
    };
  }

  const authConfig = readCliAuthConfig(context.env);
  if (!authConfig) {
    return {
      ok: false,
      error: 'Document editing requires a server connection. Please log in first.',
    };
  }

  const sourceAbsPath = resolveProjectPath(context.rootDir, sourcePath);
  if (!existsSync(sourceAbsPath)) {
    const suggestion = suggestClosestPath(context.rootDir, sourceAbsPath);
    return {
      ok: false,
      filePath: sourcePath,
      error: suggestion
        ? `File does not exist: ${sourcePath}. Did you mean "${suggestion}"? Note the exact punctuation (e.g. curly apostrophe ’ vs straight ').`
        : `File does not exist: ${sourcePath}`,
      failureCategory: 'not_found',
    };
  }

  const validateOnly = args.validate === true || args.dryRun === true;

  const serverResult = await replaceDocumentTextOnServer(
    authConfig,
    path.basename(sourcePath),
    readFileSync(sourceAbsPath),
    replacements,
    args.replaceAll === true || args.replace_all === true,
    validateOnly,
  );
  if (!serverResult.ok) {
    return {
      ...serverResult,
      filePath: sourcePath,
      failureCategory: serverResult.failureCategory ?? 'external_service',
    };
  }

  // Validate-only: report per-replacement match info without touching the file.
  // changed:false marks it non-mutating so the agent loop does not count a
  // dry-run as an applied edit.
  if (validateOnly) {
    return {
      ok: true,
      validate: true,
      changed: false,
      filePath: sourcePath,
      operation: 'replace_document_text',
      results: serverResult.results,
    };
  }

  // No replacement matched: nothing was written. Surface per-item reasons so
  // the model can correct and resend only the failing entries.
  const replacementCount = Number(serverResult.replacementCount ?? 0);
  if (replacementCount === 0) {
    const failures = Array.isArray(serverResult.replacements)
      ? serverResult.replacements
          .filter((item: any) => item && item.ok === false)
          .map((item: any) => `- ${item.error ?? 'no match'}`)
      : [];
    return {
      ok: false,
      filePath: sourcePath,
      operation: 'replace_document_text',
      failureCategory: 'conflict',
      error:
        `0 of ${serverResult.requestedCount ?? replacements.length} replacements applied; file unchanged.` +
        (failures.length ? `\n${failures.join('\n')}` : ''),
      replacements: serverResult.replacements,
    };
  }

  const preview = String(serverResult.preview ?? '');
  renderPreview(targetPath, preview);
  // outputPath may name a file that does not exist yet, in which case this
  // tool creates rather than edits. Classify from disk, as write_file does, so
  // an edit grant cannot quietly create files.
  const targetHashBeforeApproval = getCurrentFileHash(context.rootDir, targetPath);
  const documentIsNew = targetHashBeforeApproval === null;
  const denied = await ensurePermission(
    context,
    {
      bucket: documentIsNew ? 'create' : 'edit',
      title: documentIsNew ? 'Approve new document?' : 'Approve document edit?',
      body: 'Review changes before applying.',
      filePath: targetPath,
      diff: preview,
    },
    'replace_document_text',
    { filePath: targetPath },
  );
  if (denied) {
    if (!isTuiMode()) {
      console.log(chalk.dim(`  replace_document_text skipped: ${targetPath}`));
    }
    return denied;
  }

  const fileData = String(serverResult.fileData ?? '');
  // Same window as write_file: the prompt can sit open for as long as it takes
  // to read, and `result`/`fileData` was computed from the source before it
  // opened. Re-check the target so a file created or changed meanwhile is not
  // clobbered by a stale render under an approval that described a different
  // file.
  if (getCurrentFileHash(context.rootDir, targetPath) !== targetHashBeforeApproval) {
    return {
      ok: false,
      filePath: targetPath,
      failureCategory: 'conflict',
      error:
        `replace_document_text refused: ${targetPath} changed on disk while the approval prompt was open.`,
      failureDetails: {
        category: 'conflict',
        tool: 'replace_document_text',
        action:
          'Re-read the document to see its current contents, then rebuild the replacements against it and retry.',
      },
    };
  }

  const nextData = Buffer.from(fileData, 'base64');
  const write = writeProjectFileBuffer(context.rootDir, targetPath, nextData);
  const failedCount = Number(serverResult.failedCount ?? 0);
  const appliedCount = Number(serverResult.appliedCount ?? replacementCount);
  const requestedCount = Number(
    serverResult.requestedCount ?? replacements.length,
  );
  const partialFailures = Array.isArray(serverResult.replacements)
    ? serverResult.replacements
        .filter((item: any) => item && item.ok === false)
        .map((item: any) => `- ${item.error ?? 'no match'}`)
    : [];
  return {
    ok: true,
    filePath: targetPath,
    sourceFilePath: sourcePath,
    changed: write.changed,
    operation: 'replace_document_text',
    replacementCount: serverResult.replacementCount,
    requestedCount: serverResult.requestedCount,
    appliedCount: serverResult.appliedCount,
    failedCount: serverResult.failedCount,
    replacements: serverResult.replacements,
    bytesWritten: nextData.length,
    // A partial batch still wrote the matched entries (changed:true above), but
    // the loop must reflect and repair the missed entries — needsRepair forces
    // that without losing credit for the applied edits.
    ...(failedCount > 0
      ? {
          needsRepair: true,
          failureCategory: 'conflict',
          error:
            `${appliedCount} of ${requestedCount} replacements applied; ` +
            `${failedCount} missed and still need to be fixed:\n` +
            partialFailures.join('\n'),
          failureDetails: {
            category: 'conflict',
            tool: 'replace_document_text',
            action:
              'Re-issue replace_document_text for the missed entries only, with corrected oldText. ' +
              'Copy the exact text from read_document (mind curly vs straight quotes), or pass validate:true to test a match first.',
          },
        }
      : {}),
  };
}
