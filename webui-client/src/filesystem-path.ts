export function joinFilesystemPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent.replace(/\/+$/u, "")}/${name}`;
}

export function parentFilesystemPath(path: string): string {
  const normalized = path.replace(/\/+$/u, "") || "/";
  if (normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}
