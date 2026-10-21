import { HttpError } from "../utils/httpError.js";

export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query
    });

    if (!result.success) {
      const flattened = result.error.flatten();
      const fieldErrors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0] === "body" ? issue.path[1] : issue.path[0];
        if (!field) continue;
        fieldErrors[field] = fieldErrors[field] || [];
        fieldErrors[field].push(issue.message);
      }
      return next(new HttpError(400, "Please correct the highlighted fields.", {
        ...flattened,
        fieldErrors
      }));
    }

    req.validated = result.data;
    next();
  };
}
