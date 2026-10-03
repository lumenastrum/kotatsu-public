import express from 'express';

import { router as branchesRouter } from './branches.js';
import { router as themesRouter } from './themes.js';
import { router as claudeBridgeRouter } from './claude-bridge/index.js';
import { router as updateRouter } from './update.js';
import { router as marketplaceRouter } from './marketplace/index.js';
import { router as phoneRouter } from './phone/index.js';
import { router as chatgptBridgeRouter } from './chatgpt-bridge/index.js';

export const router = express.Router();

router.use('/branches', branchesRouter);
router.use('/themes', themesRouter);
router.use('/claude-bridge', claudeBridgeRouter);
router.use('/update', updateRouter);
router.use('/marketplace', marketplaceRouter);
router.use('/phone', phoneRouter);
router.use('/chatgpt-bridge', chatgptBridgeRouter);
