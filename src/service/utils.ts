import { InputError } from '@backstage/errors';
import { z } from 'zod';
import { Request } from 'express';
import lodash from 'lodash';
import path from 'path';
import { resolvePackagePath } from '@backstage/backend-common';

export const getProtoUploadPath = (entityName: string) =>
  resolvePackagePath(
    '@backstage/plugin-bloomrpc-backend',
    path.join('proto', entityName),
  );

export enum LoadProtoStatus {
  ok = 1,
  fail = -1,
  part = 0,
}

export function getFileNameFromPath(p: string) {
  return path.basename(p);
}

/**
 * @author thaotx3
 * @param paths
 * @returns all possible dirname of a path until hit the basepath
 */
export function getAllPossibleSubPaths(basePath: string, ...paths: string[]) {
  const allPaths: Set<string> = new Set();

  paths.forEach(str => {
    const relativePath = getRelativePath(basePath, str);
    if (!relativePath || relativePath.startsWith('../')) return;

    let extracted = str;
    while (extracted !== basePath) {
      extracted = path.dirname(extracted);
      allPaths.add(extracted);
    }
  });

  return Array.from(allPaths);
}

/**
 * Return full path
 * @param to relative path to the basePath
 */
export function resolveRelativePath(basePath: string, to: string) {
  return path.resolve(basePath, to);
}

export function getRelativePath(from: string, to: string) {
  return path.isAbsolute(to) ? path.relative(from, to) : to;
}

export function getAbsolutePath(from: string, to: string) {
  return path.isAbsolute(to) ? to : resolveRelativePath(from, to);
}

export async function requireRequestBody(req: Request): Promise<unknown> {
  const contentType = req.header('content-type');
  if (!contentType) {
    throw new InputError('Content-Type missing');
  } else if (!contentType.match(/^application\/json($|;)/)) {
    throw new InputError('Illegal Content-Type');
  }

  const body = req.body;
  if (!body) {
    throw new InputError('Missing request body');
  } else if (!lodash.isPlainObject(body)) {
    throw new InputError('Expected body to be a JSON object');
  } else if (Object.keys(body).length === 0) {
    // Because of how express.json() translates the empty body to {}
    throw new InputError('Empty request body');
  }

  return body;
}

export async function validateRequestBody<T>(
  req: Request,
  schema: z.Schema<T>,
): Promise<T> {
  const body = await requireRequestBody(req);
  try {
    return await schema.parse(body);
  } catch (e) {
    throw new InputError(`Malformed request: ${e}`);
  }
}

export const placeholderFile = (() => {
  const baseFile = {
    fileName: z.string(),
    filePath: z.string(),
    isPreloaded: z.boolean().optional(),
    url: z.string().optional(),
  };

  return z.object({
    ...baseFile,
    imports: z.array(z.object(baseFile)).optional(),
  });
})();

export const sendRequestInput = z
  .object({
    requestId: z.string(),
    requestData: z
      .object({
        inputs: z.record(z.any()),
        metadata: z.record(z.string()),
        stream: z.any(),
      })
      .required(),
    proto: z.string(),
    methodName: z.string(),
    serviceName: z.string(),
    url: z.string(),
    imports: z.array(placeholderFile).optional(),
    interactive: z.boolean(),
  })
  .strict(); // no unknown keys;

export const getProtoInput = z.object({
  entitySpec: z.object({
    definition: z.string().optional(),
    files: z.array(placeholderFile),
    imports: z.array(placeholderFile).optional(),
    targets: z.unknown(),
  }),
});
