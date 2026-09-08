import express from 'express';

import { router as branchesRouter } from './branches.js';
import { router as themesRouter } from './themes.js';
import { router as claudeBridgeRouter } from './claude-bridge/index.js';
import { router as updateRouter } from './update.js';

export const router = express.Router();

router.use('/branches', branchesRouter);
router.use('/themes', themesRouter);
router.use('/claude-bridge', claudeBridgeRouter);
router.use('/update', updateRouter);
