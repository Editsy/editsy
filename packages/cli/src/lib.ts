/**
 * Programmatic API of @editsy/cli: what framework adapters (e.g.
 * @editsy/next) build on: the fetch-style API handler, the content
 * backends, auth, and editor-asset serving.
 */
export { createApiHandler, type ApiHandler, type ApiOptions } from "./api.js";
export {
  AssetExistsError,
  ConflictError,
  LocalDiskBackend,
  contentRev,
  type BackendInfo,
  type ContentBackend,
  type WriteManyItem,
} from "./backend.js";
export { GitHubBackend, type GitHubBackendOptions } from "./github.js";
export {
  authFromEnv,
  checkLogin,
  createLoginToken,
  createSession,
  hashPassword,
  loadEditorsFile,
  parseEditors,
  verifyLoginToken,
  verifyPassword,
  verifySession,
  type AuthConfig,
  type Editor,
  type SessionUser,
} from "./auth.js";
export { createSmtpMailer, mailerFromEnv, type Mailer } from "./mailer.js";
export { RateLimiter } from "./rate-limit.js";
export { DEFAULT_CONFIG, loadConfig, type EditsyConfig, type EditsyTheme } from "./config.js";
export { resolveEditorDist, serveEditorAsset } from "./static.js";
export { runCheck, formatCheckResult } from "./check.js";
export { runInit, installCommand, type InitResult } from "./init.js";
export { runDoctor, formatDoctorResult, parseDotenv, type DoctorCheck, type DoctorStatus } from "./doctor.js";
export { readContent } from "./ast/read.js";
export { applyValues, WriteError } from "./ast/write.js";
export { toValues, type ContentDoc, type FieldNode, type Issue, type Value } from "./model.js";
