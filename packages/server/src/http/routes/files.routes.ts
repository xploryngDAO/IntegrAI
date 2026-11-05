import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createFileControllers } from '../controllers/file.controller';

/** `/api/v1/files` - attachment upload + presigned download. */
export const fileRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createFileControllers(ctx);
  app.post('/upload', controllers.upload);
  app.get('/signed', controllers.signed);
};
