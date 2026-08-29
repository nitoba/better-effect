export type ProgramIdentity = (...arguments_: never[]) => void

const programNames = new WeakMap<ProgramIdentity, string>()

/** Return the private diagnostic name attached to a callable Program. */
export const getProgramName = (program: ProgramIdentity): string | undefined =>
  programNames.get(program)

/** Attach a name without changing the callable Program facade. */
export const setProgramName = <Program extends ProgramIdentity>(
  program: Program,
  name: string
): Program => {
  programNames.set(program, name)
  return program
}

/** Copy a source Program's name to a lazily-created derived Program. */
export const inheritProgramName = <Source extends ProgramIdentity, Derived extends ProgramIdentity>(
  source: Source,
  derived: Derived
): Derived => {
  const name = getProgramName(source)

  return name === undefined ? derived : setProgramName(derived, name)
}
