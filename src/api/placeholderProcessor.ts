import { LocationSpec, PlaceholderProcessorOptions, PlaceholderResolverParams } from "@backstage/plugin-catalog-backend";
import { JsonValue } from "@backstage/types";
import yaml from 'yaml';
import { EntitySpec, PlaceholderFile, WritableFile } from "./types";

export class CustomPlaceholderProcessor {
  constructor(private readonly options: PlaceholderProcessorOptions) { }

  async processEntitySpec(
    entitySpec: EntitySpec,
  ): Promise<{ files: WritableFile[]; imports: WritableFile[] }> {
    const { files, imports } = entitySpec;

    const read = async (url: string): Promise<Buffer> => {
      if (this.options.reader.readUrl) {
        const response = await this.options.reader.readUrl(url);
        const buffer = await response.buffer();
        return buffer;
      }
      return this.options.reader.read(url);
    };

    const resolveUrl = (url: string, base: string): string =>
      this.options.integrations.resolveUrl({
        url,
        base,
      });

    const placeholderToFile = async (placeholder: PlaceholderFile): Promise<WritableFile> => {
      const resolverKey = 'text';
      const resolverValue = placeholder.url!;

      const resolver = this.options.resolvers[resolverKey];

      const content = await resolver({
        key: resolverKey,
        value: resolverValue,
        baseUrl: '',
        read,
        resolveUrl,
      }) as string;

      return {
        fileName: placeholder.fileName,
        filePath: placeholder.filePath,
        content,
      }
    }

    const resolveFiles = Promise.all([files].flat().map(placeholderToFile));
    const resolveImports = Promise.all((imports || []).map(placeholderToFile));

    const [resolvedFiles, resolvedImports] = await Promise.all([resolveFiles, resolveImports]);

    return {
      files: resolvedFiles,
      imports: resolvedImports
    }
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
