import * as z from "zod"

import { Schema } from "better-effect-zod"

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

StrictPerson.parse({ id: 1, name: "Ada" })
LoosePerson.parse({ id: 1, name: "Ada", source: "api" })
MetadataPerson.parse({ id: 1, name: "Ada", source: "api" })

console.log("object-modes: ok")
