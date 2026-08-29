import * as core from 'better-effect-mq'
import * as testing from 'better-effect-mq/testing'
import packageJson from 'better-effect-mq/package.json' with { type: 'json' }

const packageName: string = packageJson.name

void core
void testing
void packageName
