import { Logger } from 'winston';
import logger from '../../src/util/logger';
import { fixture } from '../helpers';

import {
    ChatPostMessageResult,
    SlackTeam
} from '../../src/lib/slack_team';

const postMsgResponse = fixture('slack/chat.postMessage.response') as ChatPostMessageResult;
const loggerSpy = jest.spyOn(logger, 'error').mockReturnValue(({} as unknown) as Logger);

afterEach(() => {
    jest.clearAllMocks();
});

describe('SlackTeam', () => {
    const team = new SlackTeam({ id: 'abc', domain: 'foo' });
    team.config = { support_channel_id: 'channel-1234' };
    const postMessageMock = jest.spyOn(team.client.chat, 'postMessage');
    const dialogOpenMock = jest.spyOn(team.client.dialog, 'open');

    describe('#postSupportRequest(message)', () => {
        const msg = 'This is my message';

        it('returns a Promise that resolves to slack WebAPICallResult', (done) => {
            postMessageMock.mockImplementation(() => {
                return Promise.resolve(postMsgResponse);
            });

            expect(team.postSupportRequest(msg)).resolves.toEqual(postMsgResponse);

            done();
        });

        it('sends the message to team slack', (done) => {
            postMessageMock.mockImplementation(() => {
                return Promise.resolve(postMsgResponse);
            });

            team.postSupportRequest(msg);
            const call = postMessageMock.mock.calls[0][0];
            expect(call.text).toEqual(msg);
            expect(call.channel).toEqual('channel-1234');

            done();
        });

        describe('failure', () => {
            it('it catch and log the failure', (done) => {
                postMessageMock.mockImplementation(() => {
                    return Promise.reject({ ok: false });
                });

                expect(team.postSupportRequest(msg)).rejects.toEqual({ ok: false });
                team.postSupportRequest(msg).catch(() => {
                    expect(loggerSpy).toHaveBeenCalled();
                });

                done();
            });
        });
    });

    describe('#showSupportRequestForm()', () => {
        const request_type = 'bug';
        const trigger_id = 'tr123';

        it('returns a Promise that resolves to slack WebAPICallResult', (done) => {
            dialogOpenMock.mockImplementation(() => {
                return Promise.resolve({ ok: true });
            });

            expect(team.showSupportRequestForm(request_type, trigger_id))
                .resolves.toEqual({ ok: true });

            done();
        });

        describe('failure', () => {
            it('it catch and log the failure', (done) => {
                dialogOpenMock.mockImplementation(() => {
                    return Promise.reject({ ok: false });
                });

                expect(team.showSupportRequestForm(request_type, trigger_id))
                    .rejects.toEqual({ ok: false });
                team.showSupportRequestForm(request_type, trigger_id).catch(() => {
                    expect(loggerSpy).toHaveBeenCalled();
                });

                done();
            });
        });
    });
});
