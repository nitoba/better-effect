export type Assert<Condition extends true> = Condition

export type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false

export type IsAssignable<From, To> = [From] extends [To] ? true : false

export type IsNotAssignable<From, To> = IsAssignable<From, To> extends true ? false : true

export type IsAny<Value> = 0 extends 1 & Value ? true : false
