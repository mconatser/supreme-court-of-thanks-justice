/**
 * Box (court only): the Family Code lives here, and every ruling is filed here.
 *
 * Verified on fc-court-dev (2026-11-24):
 * - GET /2.0/files/{id}/content comes back 200 through the gateway (it follows Box's redirect).
 *   A 3xx is still handled: the Location is a pre-signed download URL that needs no credentials.
 * - Uploads: POST /upload/files/content (multipart, attributes before file). New versions:
 *   POST /upload/files/{id}/content. The gateway caps requests at 50 MiB.
 */
import { GatewayError, friendlyGatewayMessage, type Gateway } from "../shared/gateway.ts";

export interface BoxFileInfo {
  id: string;
  name: string;
  versionId: string;
  modifiedAt: string;
}

export class BoxClient {
  constructor(private readonly gateway: Gateway) {}

  private async ok(res: Response, what: string): Promise<Response> {
    if (res.ok) return res;
    throw new GatewayError("box", res.status, `${friendlyGatewayMessage("Box", res.status)} (${what})`);
  }

  async fileInfo(fileId: string): Promise<BoxFileInfo> {
    const res = await this.ok(
      await this.gateway.gw("box", `/2.0/files/${encodeURIComponent(fileId)}?fields=name,file_version,modified_at`, {
        signal: AbortSignal.timeout(20_000),
      }),
      "file info",
    );
    const d = (await res.json()) as { id: string; name: string; file_version?: { id: string }; modified_at?: string };
    return { id: d.id, name: d.name, versionId: d.file_version?.id ?? "", modifiedAt: d.modified_at ?? "" };
  }

  /** The file with this exact name in a folder, if any. */
  async findInFolder(folderId: string, name: string): Promise<string | null> {
    const res = await this.ok(
      await this.gateway.gw("box", `/2.0/folders/${encodeURIComponent(folderId)}/items?fields=name&limit=1000`, { signal: AbortSignal.timeout(20_000) }),
      "folder listing",
    );
    const d = (await res.json()) as { entries?: { id: string; name: string; type?: string }[] };
    return d.entries?.find((e) => e.name === name && (e.type ?? "file") === "file")?.id ?? null;
  }

  async downloadText(fileId: string): Promise<string> {
    const res = await this.gateway.gw("box", `/2.0/files/${encodeURIComponent(fileId)}/content`, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new GatewayError("box", res.status, "Box sent a redirect without a location.");
      const dl = await fetch(location, { signal: AbortSignal.timeout(30_000) }); // pre-signed; no credentials
      if (!dl.ok) throw new GatewayError("box", dl.status, `Box download failed (HTTP ${dl.status}).`);
      return dl.text();
    }
    return (await this.ok(res, "download")).text();
  }

  private form(attributes: object, name: string, content: string): FormData {
    const fd = new FormData();
    fd.append("attributes", JSON.stringify(attributes)); // Box requires attributes before the file
    fd.append("file", new Blob([content], { type: "text/markdown" }), name);
    return fd;
  }

  /**
   * Upload a text file into a folder. If the name is taken (409), upload a new version of the
   * existing file instead. Returns the file id and new version id.
   */
  async upsertText(folderId: string, name: string, content: string): Promise<BoxFileInfo> {
    const res = await this.gateway.gw("box", "/upload/files/content", {
      method: "POST",
      body: this.form({ name, parent: { id: folderId } }, name, content),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 409) {
      const err = (await res.json().catch(() => ({}))) as { context_info?: { conflicts?: { id?: string } | { id?: string }[] } };
      const conflicts = err.context_info?.conflicts;
      const existing = Array.isArray(conflicts) ? conflicts[0]?.id : conflicts?.id;
      if (!existing) throw new GatewayError("box", 409, `Box says "${name}" already exists, but didn't say which file it is.`);
      return this.uploadVersion(existing, name, content);
    }
    return this.entry(await this.ok(res, "upload"));
  }

  async uploadVersion(fileId: string, name: string, content: string): Promise<BoxFileInfo> {
    const res = await this.gateway.gw("box", `/upload/files/${encodeURIComponent(fileId)}/content`, {
      method: "POST",
      body: this.form({ name }, name, content),
      signal: AbortSignal.timeout(60_000),
    });
    return this.entry(await this.ok(res, "new version"));
  }

  private async entry(res: Response): Promise<BoxFileInfo> {
    const d = (await res.json()) as { entries?: { id: string; name: string; file_version?: { id: string }; modified_at?: string }[] };
    const e = d.entries?.[0];
    if (!e) throw new GatewayError("box", res.status, "Box didn't say what it uploaded.");
    return { id: e.id, name: e.name, versionId: e.file_version?.id ?? "", modifiedAt: e.modified_at ?? "" };
  }
}
