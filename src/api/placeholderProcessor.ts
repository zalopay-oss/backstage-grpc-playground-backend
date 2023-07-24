import {
  PlaceholderProcessorOptions,
  PlaceholderResolverParams,
} from '@backstage/plugin-catalog-backend';
import { JsonValue } from '@backstage/types';
import yaml from 'yaml';
import fs from 'fs';
import path from 'path';
import { EntitySpec, Library, PlaceholderFile, WritableFile } from './types';
import { getFileNameFromPath, LIBRARY_BASE_PATH, resolveRelativePath } from '../service/utils';
import { Logger } from 'winston';

interface ProcessResult {
  files: WritableFile[];
  imports: WritableFile[];
  libraries: WritableFile[];
}
function getAllFiles(dir: string, parent?: string) {
  const fileNames: string[] = [];
  const fileOrDirs = fs.readdirSync(dir, { withFileTypes: true })

  fileOrDirs.forEach(fileOrDir => {
    const currentPath = parent ? path.join(parent, fileOrDir.name) : fileOrDir.name;
    if (fileOrDir.isDirectory()) {
      fileNames.push(...getAllFiles(path.join(dir, fileOrDir.name), currentPath));
    } else {
      fileNames.push(currentPath);
    }
  });

  return fileNames;
}
export class CustomPlaceholderProcessor {
  constructor(private readonly options: PlaceholderProcessorOptions & {
    logger: Logger;
  }) { }

  async processEntitySpec(
    entitySpec: EntitySpec,
  ): Promise<ProcessResult> {
    const logger = this.options.logger;
    const { files, imports, libraries } = entitySpec;

    logger.info(`OUTPUT ~ CustomPlaceholderProcessor ~ libraries: ${libraries}`);

    const read = async (url: string): Promise<Buffer> => {
      //if (this.options.reader.readUrl) {
        const response = await this.options.reader.readUrl(url);
        const buffer = await response.buffer();
        return buffer;
      //}
      //return this.options.reader.read(url);
    };

    const readLibrary = async (lib: Library) => {
      const { name: libName, path: libPath = '', version = 'default', url } = lib;
      const prefix = path.join(...[libName, version, libPath].filter(Boolean));
      const libDir = resolveRelativePath(LIBRARY_BASE_PATH, prefix);

      logger.info(`OUTPUT ~ CustomPlaceholderProcessor ~ readLibrary ~ libDir: ${libDir}`);

      // Check if we have downloaded this library before
      if (fs.existsSync(libDir)) {
        try {
          const libLocalFileNames = getAllFiles(libDir);
          logger.info(`CustomPlaceholderProcessor ~ readLibrary ~ downloaded lib before ${libDir}, files ${libLocalFileNames}`);

          return libLocalFileNames.map(fileName => {
            const writableFile: WritableFile = {
              fileName: fileName,
              filePath: path.join(libDir, fileName),
            };

            return writableFile;
          });
        } catch {
          // Ignore
        }
      }

      if (url && this.options.reader.readTree) {
        logger.info(`CustomPlaceholderProcessor ~ readLibrary ~ downloading library url ${url}`);

        const readTreeResult = await this.options.reader.readTree(url);
        const treeFiles = await readTreeResult.files();

        return Promise.all(treeFiles.map(async (file): Promise<WritableFile> => {
          const content = await file.content();
          const fileName = getFileNameFromPath(file.path);
          const fullPath = path.join(libDir, file.path);

          logger.info(`OUTPUT ~ CustomPlaceholderProcessor ~ library file path: ${file.path}, full path ${fullPath}`);

          return {
            fileName,
            filePath: fullPath,
            content: content.toString('utf-8')
          };
        }));
      }

      return [];
    }

    const resolveUrl = (url: string, base: string): string =>
      this.options.integrations.resolveUrl({
        url,
        base,
      });

    const placeholderToFile = async (
      placeholder: PlaceholderFile,
    ): Promise<WritableFile> => {
      const resolverKey = 'text';
      const resolverValue = placeholder.url;
      let content: string | undefined;

      if (resolverValue) {
        const resolver = this.options.resolvers[resolverKey];

        content = (await resolver({
          key: resolverKey,
          value: resolverValue,
          baseUrl: '',
          read,
          emit: () => { }, // turnoff ts complains, we dont emit anything
          resolveUrl,
        })) as string;
      }

      let resolvedImports: WritableFile[] | undefined;

      if (placeholder.imports) {
        resolvedImports = await Promise.all(
          placeholder.imports.map(placeholderToFile),
        );
      }

      return {
        fileName: placeholder.fileName,
        filePath: placeholder.filePath,
        content,
        url: placeholder.url,
        imports: resolvedImports,
      };
    };

    const resolveFiles = Promise.all(files.map(placeholderToFile));
    const resolveImports = Promise.all((imports || []).map(placeholderToFile));

    const resolveLibraries = Promise.all((libraries || []).map(readLibrary));

    const [resolvedFiles, resolvedImports, resolvedLibraries] = await Promise.all([
      resolveFiles,
      resolveImports,
      resolveLibraries
    ]);

    return {
      files: resolvedFiles,
      imports: resolvedImports,
      libraries: resolvedLibraries.flat(),
    };
  }
}

/*
 * Resolvers
 */

export async function yamlPlaceholderResolver(
  params: PlaceholderResolverParams,
): Promise<JsonValue> {
  const text = await readTextLocation(params);

  let documents: yaml.Document.Parsed[];
  try {
    documents = yaml.parseAllDocuments(text).filter(d => d);
  } catch (e) {
    throw new Error(
      `Placeholder \$${params.key} failed to parse YAML data at ${params.value}, ${e}`,
    );
  }

  if (documents.length !== 1) {
    throw new Error(
      `Placeholder \$${params.key} expected to find exactly one document of data at ${params.value}, found ${documents.length}`,
    );
  }

  const document = documents[0];

  if (document.errors?.length) {
    throw new Error(
      `Placeholder \$${params.key} found an error in the data at ${params.value}, ${document.errors[0]}`,
    );
  }

  return document.toJSON();
}

export async function jsonPlaceholderResolver(
  params: PlaceholderResolverParams,
): Promise<JsonValue> {
  const text = await readTextLocation(params);

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Placeholder \$${params.key} failed to parse JSON data at ${params.value}, ${e}`,
    );
  }
}

export async function textPlaceholderResolver(
  params: PlaceholderResolverParams,
): Promise<JsonValue> {
  return await readTextLocation(params);
}

/*
 * Helpers
 */

async function readTextLocation(
  params: PlaceholderResolverParams,
): Promise<string> {
  const newUrl = relativeUrl(params);

  try {
    const data = await params.read(newUrl);
    return data.toString('utf-8');
  } catch (e) {
    throw new Error(
      `Placeholder \$${params.key} could not read location ${params.value}, ${e}`,
    );
  }
}

function relativeUrl({
  key,
  value,
  baseUrl,
  resolveUrl,
}: PlaceholderResolverParams): string {
  if (typeof value !== 'string') {
    throw new Error(
      `Placeholder \$${key} expected a string value parameter, in the form of an absolute URL or a relative path`,
    );
  }

  try {
    return resolveUrl(value, baseUrl);
  } catch (e) {
    // The only remaining case that isn't support is a relative file path that should be
    // resolved using a relative file location. Accessing local file paths can lead to
    // path traversal attacks and access to any file on the host system. Implementing this
    // would require additional security measures.
    throw new Error(
      `Placeholder \$${key} could not form a URL out of ${baseUrl} and ${value}, ${e}`,
    );
  }
}
