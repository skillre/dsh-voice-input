/** CSS Modules declaration: `import css from './*.module.css'`. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
