import { SourceBase, Tree } from "../types";
import config from "../../config";
import { Stream } from "node:stream";
import * as fs from "fs";
import { Extract } from "unzip-stream";
import { join, basename, dirname } from "path";
import { Response } from "express";
import { Readable, pipeline, Transform } from "stream";
import * as archiver from "archiver";
import { promisify } from "util";
import AnonymizedFile from "../AnonymizedFile";
import { lookup } from "mime-types";
import { trace } from "@opentelemetry/api";
import StorageBase, { FILE_TYPE } from "./Storage";

export default class FileSystem extends StorageBase {
  type = "FileSystem";

  constructor() {
    super();
  }

  /** @override */
  async exists(repoId: string, p: string = ""): Promise<FILE_TYPE> {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    return trace
      .getTracer("ano-file")
      .startActiveSpan("fs.exists", async (span) => {
        span.setAttribute("path", p);
        span.setAttribute("full-path", fullPath);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.isDirectory()) return FILE_TYPE.FOLDER;
          if (stat.isFile()) return FILE_TYPE.FILE;
        } catch (_) {
          // ignore file not found or not downloaded
        }
        span.end();
        return FILE_TYPE.NOT_FOUND;
      });
  }

  /** @override */
  async send(repoId: string, p: string, res: Response) {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    return trace
      .getTracer("ano-file")
      .startActiveSpan("fs.send", async (span) => {
        span.setAttribute("path", fullPath);
        res.sendFile(fullPath, { dotfiles: "allow" }, (err) => {
          if (err) {
            span.recordException(err);
          }
          span.end();
        });
      });
  }

  /** @override */
  async read(repoId: string, p: string): Promise<Readable> {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    return fs.createReadStream(fullPath);
  }

  async fileInfo(repoId: string, path: string) {
    const fullPath = join(config.FOLDER, this.repoPath(repoId), path);
    const info = await fs.promises.stat(fullPath);
    return {
      size: info.size,
      lastModified: info.mtime,
      contentType: info.isDirectory()
        ? "application/x-directory"
        : (lookup(fullPath) as string),
    };
  }

  /** @override */
  async write(
    repoId: string,
    p: string,
    data: string | Readable,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    const span = trace.getTracer("ano-file").startSpan("fs.write");
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    span.setAttribute("path", fullPath);
    try {
      await this.mk(repoId, dirname(p));
      return await fs.promises.writeFile(fullPath, data, "utf-8");
    } finally {
      span.end();
    }
  }

  /** @override */
  async rm(repoId: string, dir: string = ""): Promise<void> {
    const span = trace.getTracer("ano-file").startSpan("fs.rm");
    const fullPath = join(config.FOLDER, this.repoPath(repoId), dir);
    span.setAttribute("path", fullPath);
    try {
      await fs.promises.rm(fullPath, {
        force: true,
        recursive: true,
      });
    } finally {
      span.end();
    }
  }

  /** @override */
  async mk(repoId: string, dir: string = ""): Promise<void> {
    const span = trace.getTracer("ano-file").startSpan("fs.mk");
    span.setAttribute("path", dir);
    const fullPath = join(config.FOLDER, this.repoPath(repoId), dir);
    try {
      await fs.promises.mkdir(fullPath, {
        recursive: true,
      });
    } catch (err: any) {
      if (err.code !== "EEXIST") {
        span.recordException(err);
        throw err;
      }
    } finally {
      span.end();
    }
  }

  /** @override */
  async listFiles(
    repoId: string,
    dir: string = "",
    opt: {
      onEntry?: (file: { path: string; size: number }) => void;
    } = {}
  ): Promise<Tree> {
    return trace
      .getTracer("ano-file")
      .startActiveSpan("fs.listFiles", async (span) => {
        span.setAttribute("path", dir);
        const fullPath = join(config.FOLDER, this.repoPath(repoId), dir);
        let files = await fs.promises.readdir(fullPath);
        const output: Tree = {};
        for (let file of files) {
          let filePath = join(dir, file);
          try {
            const stats = await fs.promises.stat(join(fullPath, filePath));
            if (file[0] == "$") {
              file = "\\" + file;
            }
            if (stats.isDirectory()) {
              output[file] = await this.listFiles(repoId, filePath, opt);
            } else if (stats.isFile()) {
              if (opt.onEntry) {
                opt.onEntry({
                  path: filePath,
                  size: stats.size,
                });
              }
              output[file] = { size: stats.size, sha: stats.ino.toString() };
            }
          } catch (error) {
            span.recordException(error as Error);
          }
        }
        span.end();
        return output;
      });
  }

  /** @override */
  async extractZip(
    repoId: string,
    p: string,
    data: Readable,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void> {
    const pipe = promisify(pipeline);
    const fullPath = join(config.FOLDER, this.repoPath(repoId), p);
    return pipe(
      data,
      Extract({
        path: fullPath,
        decodeString: (buf) => {
          const name = buf.toString();
          const newName = name.substr(name.indexOf("/") + 1);
          if (newName == "") return "/dev/null";
          return newName;
        },
      })
    );
  }

  /** @override */
  async archive(
    repoId: string,
    dir: string,
    opt?: {
      format?: "zip" | "tar";
      fileTransformer?: (path: string) => Transform;
    }
  ) {
    const archive = archiver(opt?.format || "zip", {});
    const fullPath = join(config.FOLDER, this.repoPath(repoId), dir);

    await this.listFiles(repoId, dir, {
      onEntry: async (file) => {
        let rs = await this.read(repoId, file.path);
        if (opt?.fileTransformer) {
          // apply transformation on the stream
          rs = rs.pipe(opt.fileTransformer(file.path));
        }
        const f = file.path.replace(fullPath, "");
        archive.append(rs, {
          name: basename(f),
          prefix: dirname(f),
        });
      },
    }).then(() => {
      archive.finalize();
    });
    return archive;
  }
}
