import { BetterAuth } from 'better-effect-better-auth'

import { authWithoutPlugins } from '../auth'

const Auth = BetterAuth.service('@invalid/AbsentPlugin', authWithoutPlugins)

void Auth
void authWithoutPlugins.api.listUsers
