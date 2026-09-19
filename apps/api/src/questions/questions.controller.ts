import 'reflect-metadata';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { QuestionsService } from './questions.service.js';

/** /api/questions* 与 /api/question-taxonomy：问题详情、用户标签、重标与分类法。 */
@Controller()
export class QuestionsController {
    constructor(private readonly questions: QuestionsService) {}

    @Get('question-taxonomy')
    taxonomy() {
        return this.questions.taxonomy();
    }

    @Get('questions/:questionId')
    get(@Param('questionId') questionId: string) {
        return this.questions.get(questionId);
    }

    @Post('questions/:questionId/labels')
    addLabels(@Param('questionId') questionId: string, @Body() body: Record<string, unknown>) {
        return this.questions.addLabels(questionId, body);
    }

    @Post('questions/:questionId/classify')
    classify(@Param('questionId') questionId: string) {
        return this.questions.classify(questionId);
    }
}
