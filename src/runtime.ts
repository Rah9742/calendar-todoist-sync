/** Request-scoped environment after the serialized consumer resolves the rotating token.
 * The access token is runtime data, not a required static deployment credential.
 */
export type AuthenticatedEnv = Env & { TODOIST_ACCESS_TOKEN: string };
