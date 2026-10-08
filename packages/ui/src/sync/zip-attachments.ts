/**
 * ZIP attachments — uploaded to the session workspace instead of inlined.
 *
 * Model providers reject application/zip file parts, so a zip is streamed to
 * `<session directory>/.openchamber/uploads/` through the runtime files API
 * and the prompt carries a synthetic note with the path; the agent extracts
 * the archive with its own shell tools.
 */

import type { AttachedFile } from "@/stores/types/sessionTypes"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"

export const ZIP_UPLOAD_DIRECTORY = ".openchamber/uploads"
export const MAX_ZIP_UPLOAD_BYTES = 100 * 1024 * 1024

export type ZipUploadFailure = "too-large" | "unsupported-runtime" | "upload-failed"

type ZipUploadOutcome =
  | { status: "ready"; workspacePath: string }
  | { status: "failed"; reason: ZipUploadFailure }

const sanitizeZipFilename = (name: string): string => {
  const basename = name.replace(/\\/g, "/").split("/").pop() ?? "archive.zip"
  const cleaned = basename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, "")
  return cleaned.toLowerCase().endsWith(".zip") ? cleaned : `${cleaned || "archive"}.zip`
}

const uniqueZipUploadName = (name: string): string => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const random = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${random}-${sanitizeZipFilename(name)}`
}

const joinWorkspacePath = (directory: string, child: string): string =>
  `${directory.replace(/[\\/]+$/, "")}/${child}`

/**
 * Uploads a zip into the session workspace. Never throws: every failure is a
 * typed outcome so the composer can mark the chip failed with a reason.
 */
export const uploadZipAttachment = async (file: File, directory: string): Promise<ZipUploadOutcome> => {
  if (file.size > MAX_ZIP_UPLOAD_BYTES) return { status: "failed", reason: "too-large" }
  const files = getRegisteredRuntimeAPIs()?.files
  if (!files?.uploadFile || !directory) return { status: "failed", reason: "unsupported-runtime" }

  const uploadsDirectory = joinWorkspacePath(directory, ZIP_UPLOAD_DIRECTORY)
  try {
    await files.createDirectory(uploadsDirectory)
  } catch {
    // A concurrent attach may have created the directory first; the upload
    // below is the authoritative check.
  }
  const target = joinWorkspacePath(uploadsDirectory, uniqueZipUploadName(file.name))
  try {
    const result = await files.uploadFile(target, file, { directory })
    if (!result.success) return { status: "failed", reason: "upload-failed" }
    return { status: "ready", workspacePath: result.path || target }
  } catch {
    return { status: "failed", reason: "upload-failed" }
  }
}

/** Best-effort removal of an uploaded zip when its chip is discarded. */
export const deleteWorkspaceUpload = (workspacePath: string): void => {
  const files = getRegisteredRuntimeAPIs()?.files
  if (!files?.delete) return
  void files.delete(workspacePath).catch(() => {
    // Leftover scratch files are harmless; nothing actionable to surface.
  })
}

type PromptFilePart = {
  type: "file"
  mime: string
  url: string
  filename: string
}

const toPromptFilePart = (attachment: AttachedFile): PromptFilePart => ({
  type: "file",
  mime: attachment.mimeType,
  url: attachment.dataUrl,
  filename: attachment.filename,
})

/**
 * Splits composer attachments into inline file parts and workspace-uploaded
 * zips. Uploaded zips must never become file parts (providers reject them);
 * their path reaches the agent through the synthetic note from
 * buildZipUploadNote instead.
 */
export const partitionAttachmentsForSend = (
  attachments: readonly AttachedFile[] | undefined,
) => {
  const fileParts: PromptFilePart[] = []
  const uploadedZips: AttachedFile[] = []
  for (const attachment of attachments ?? []) {
    if (attachment.delivery === "workspace-upload") {
      uploadedZips.push(attachment)
      continue
    }
    fileParts.push(toPromptFilePart(attachment))
  }
  return { fileParts, uploadedZips }
}

const relativeZipPath = (workspacePath: string, directory: string): string => {
  const prefix = `${directory.replace(/[\\/]+$/, "")}/`
  return workspacePath.startsWith(prefix) ? workspacePath.slice(prefix.length) : workspacePath
}

/**
 * Model-facing note naming the uploaded archives. Written for the agent, not
 * the user, so it stays an English constant rather than a localized string.
 */
export const buildZipUploadNote = (
  zips: readonly AttachedFile[],
  directory: string,
): string => {
  const lines = zips.map((zip) => {
    const path = zip.workspacePath ?? zip.filename
    return `- ${path} (relative to the working directory: ${relativeZipPath(path, directory)})`
  })
  return [
    "The user attached ZIP archive(s). They were uploaded into the session workspace:",
    ...lines,
    "Do not try to read a ZIP as a message attachment. Extract it with a shell command first (for example `unzip -o <path> -d <target-dir>` or `python3 -m zipfile -e <path> <target-dir>`), then inspect the extracted files.",
  ].join("\n")
}
