import * as z from "zod"
import { Result } from "better-result"

import { Schema } from "better-effect-schema/zod"

class Person extends Schema.Class<Person>("example/ObjectModePerson")({
  id: z.int(),
  name: z.string()
}) {}

class StrictPerson extends Person.strict<StrictPerson>(
  "example/StrictPerson"
) {}

class LoosePerson extends Person.loose<LoosePerson>(
  "example/LoosePerson"
) {}

class MetadataPerson extends Person.catchall<MetadataPerson>(
  "example/MetadataPerson"
)(z.string()) {}

const strict = Schema.decodeUnknown(StrictPerson, { id: 1, name: "Ada" })
const loose = Schema.decodeUnknown(LoosePerson, { id: 1, name: "Ada", source: "api" })
const metadata = Schema.decodeUnknown(MetadataPerson, { id: 1, name: "Ada", source: "api" })
for (const result of [strict, loose, metadata]) {
  if (Result.isError(result)) throw result.error
}

console.log("object-modes: ok")
