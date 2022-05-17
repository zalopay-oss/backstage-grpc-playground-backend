/* eslint-disable import/no-extraneous-dependencies */
import { InputError, NotAllowedError } from '@backstage/errors';
import { z } from 'zod';
import { Request } from 'express';
import lodash from 'lodash';

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

export const sendRequestInput = z
  .object({
    requestId: z.string(),
    requestData: z.object({
      inputs: z.record(z.any()),
      metadata: z.record(z.string()),
      stream: z.any(),
    }).required(),
    proto: z.string(),
    methodName: z.string(),
    serviceName: z.string(),
    url: z.string(),
    interactive: z.boolean(),
  })
  .strict(); // no unknown keys;
