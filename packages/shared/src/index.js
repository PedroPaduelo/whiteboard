/**
 * `@whiteboard/shared` — the one contract both apps code against.
 *
 * apps/api (Node + Fastify) and apps/web (React + Vite) are built and deployed
 * to different places, so this package is the only thing they share. It is
 * plain ESM with zero dependencies, which means the API can import it straight
 * from source in production and the web build resolves it through the npm
 * workspace without a compile step.
 */

export * from './types.js';
export * from './geometry.js';
export * from './validate.js';
export * from './color.js';
