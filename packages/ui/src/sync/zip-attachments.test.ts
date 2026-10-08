import { afterEach, describe, expect, test } from "bun:test"
import type { RuntimeAPIs } from "@/lib/api/types"
import { registerRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import {
  MAX_ZIP_UPLOAD_BYTES,
  ZIP_UPLOAD_DIRECTORY,
  buildZipUploadNote,
  partitionAttachmentsForSend,
  uploadZipAttachment,
} from "./zip-attachments"
import type { AttachedFile } from "@/stores/types/sessionTypes"

const zipFile = (name = "archive.zip", type = "application/zip") =>
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, { type })

const attachment = (patch: Partial<AttachedFile>): AttachedFile => ({
  id: "a1",
  file: zipFile(),
  dataUrl: "",
  mimeType: "application/zip",
  filename: "archive.zip",
  size: 4,
  source: "local",
  ...patch,
})

const registerFilesApi = (files: Partial<RuntimeAPIs["files"]>) => {
  // SAFETY: the zip flow only touches `files`; other API surfaces must not be
  // reached and would surface as undefined-property test failures.
  registerRuntimeAPIs({ files } as RuntimeAPIs)
}

describe("zip workspace upload", () => {
  afterEach(() => {
    registerRuntimeAPIs(null)
  })

  test("uploads into the session workspace uploads directory with a unique name", async () => {
    const calls: Array<{ path: string; directory?: string; size: number }> = []
    const directories: string[] = []
    registerFilesApi({
      createDirectory: async (path: string) => {
        directories.push(path)
        return { success: true, path }
      },
      uploadFile: async (path: string, blob: Blob, options?: { directory?: string }) => {
        calls.push({ path, directory: options?.directory, size: blob.size })
        return { success: true, path }
      },
    })

    const outcome = await uploadZipAttachment(zipFile("My Archive.ZIP"), "/repo/project")

    expect(outcome.status).toBe("ready")
    expect(directories).toEqual([`/repo/project/${ZIP_UPLOAD_DIRECTORY}`])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.directory).toBe("/repo/project")
    expect(calls[0]?.path.startsWith(`/repo/project/${ZIP_UPLOAD_DIRECTORY}/`)).toBe(true)
    expect(calls[0]?.path.endsWith("-My-Archive.ZIP")).toBe(true)
    if (outcome.status === "ready") expect(outcome.workspacePath).toBe(calls[0]?.path)
  })

  test("rejects archives above the upload limit before touching the runtime", async () => {
    const oversized = zipFile()
    Object.defineProperty(oversized, "size", { value: MAX_ZIP_UPLOAD_BYTES + 1 })

    const outcome = await uploadZipAttachment(oversized, "/repo/project")
    expect(outcome).toEqual({ status: "failed", reason: "too-large" })
  })

  test("reports an explicit unsupported-runtime failure when uploads are unavailable", async () => {
    registerFilesApi({})
    const outcome = await uploadZipAttachment(zipFile(), "/repo/project")
    expect(outcome).toEqual({ status: "failed", reason: "unsupported-runtime" })
  })

  test("reports upload-failed when the runtime rejects the upload", async () => {
    registerFilesApi({
      createDirectory: async (path: string) => ({ success: true, path }),
      uploadFile: async () => {
        throw new Error("413")
      },
    })
    const outcome = await uploadZipAttachment(zipFile(), "/repo/project")
    expect(outcome).toEqual({ status: "failed", reason: "upload-failed" })
  })

  test("keeps workspace uploads out of file parts while passing other attachments through", () => {
    const inline = attachment({
      id: "inline",
      delivery: undefined,
      mimeType: "text/plain",
      filename: "notes.txt",
      dataUrl: "data:text/plain;base64,aGVsbG8=",
    })
    const zip = attachment({ id: "zip", delivery: "workspace-upload", uploadState: "ready", workspacePath: "/repo/project/.openchamber/uploads/a.zip" })

    const { fileParts, uploadedZips } = partitionAttachmentsForSend([inline, zip])

    expect(fileParts).toEqual([{
      type: "file",
      mime: "text/plain",
      url: "data:text/plain;base64,aGVsbG8=",
      filename: "notes.txt",
    }])
    expect(uploadedZips).toEqual([zip])
    expect(partitionAttachmentsForSend(undefined)).toEqual({ fileParts: [], uploadedZips: [] })
  })

  test("describes uploaded archives with absolute and relative paths for the agent", () => {
    const zip = attachment({
      delivery: "workspace-upload",
      uploadState: "ready",
      workspacePath: "/repo/project/.openchamber/uploads/20261003-archive.zip",
    })

    const note = buildZipUploadNote([zip], "/repo/project")

    expect(note).toContain("/repo/project/.openchamber/uploads/20261003-archive.zip")
    expect(note).toContain(".openchamber/uploads/20261003-archive.zip")
    expect(note).toContain("unzip")
  })
})
