import { setDefaultTimeout } from 'bun:test'
import { hangTimeout } from './timeout.ts'

setDefaultTimeout(hangTimeout(30_000))
