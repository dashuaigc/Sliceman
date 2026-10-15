// Resize the approved transparent logo; requires Python 3 and Pillow.
import { execFileSync } from 'node:child_process';
execFileSync('python', ['scripts/make-icons.py'], { stdio: 'inherit' });
