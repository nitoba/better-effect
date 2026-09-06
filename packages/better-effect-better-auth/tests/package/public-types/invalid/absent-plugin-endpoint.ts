import { BetterAuth } from 'better-effect-better-auth'

import { authWithoutPlugins } from '../auth'

const Auth = BetterAuth.from('@invalid/AbsentPlugin', authWithoutPlugins)

void Auth
void authWithoutPlugins.api.listUsers
