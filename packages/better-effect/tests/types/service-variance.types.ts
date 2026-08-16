import { Service, type ServiceClass, type ServiceToken } from '../../src/service'

class AnimalService extends Service<AnimalService>()('Animal') {
  readonly name: string = 'animal'
}

class DogService extends Service<DogService>()('Animal') {
  readonly name: string = 'dog'

  bark(): void {}
}

const dogClass: ServiceClass<'Animal', DogService> = DogService

// @ts-expect-error ServiceClass instance contracts are invariant
const widenedClass: ServiceClass<'Animal', AnimalService> = dogClass

const dogToken: ServiceToken<'Animal', DogService> = DogService

// @ts-expect-error ServiceToken instance contracts are invariant
const widenedToken: ServiceToken<'Animal', AnimalService> = dogToken

const widenedTag: ServiceClass<string, DogService> = dogClass

// @ts-expect-error a widened Service tag cannot be narrowed again
const narrowedTag: ServiceClass<'Animal', DogService> = widenedTag

class ManualService {
  static readonly serviceTag = 'Manual'

  static of(this: void, implementation: ManualService): ManualService {
    return implementation
  }

  run(): string {
    return 'manual'
  }
}

// @ts-expect-error Service tokens must originate from Service()
const manualToken: ServiceToken<'Manual', ManualService> = ManualService

// @ts-expect-error Service classes must originate from Service()
const manualClass: ServiceClass<'Manual', ManualService> = ManualService

class EquivalentLeft extends Service<EquivalentLeft>()('Equivalent') {
  execute(value: string): string {
    return value
  }
}

class EquivalentRight extends Service<EquivalentRight>()('Equivalent') {
  execute(value: string): string {
    return value
  }
}

const equivalentToken: ServiceToken<'Equivalent', EquivalentLeft> = EquivalentRight
const structural = DogService.of({
  name: 'structural dog',
  bark: () => {}
})

void widenedClass
void widenedToken
void widenedTag
void narrowedTag
void manualToken
void manualClass
void equivalentToken
void structural
