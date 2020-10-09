import { Response } from 'express';
import {
    Dialog,
    View,
    WebAPICallResult
} from '@slack/web-api';
import logger from '../util/logger';
import supportConfig from './support_config';
import {
    SlackMessage,
    Slack
} from './slack';
import { Jira } from './jira';
import {
    PostCommandPayload,
    DialogSubmission,
    ViewSubmission,
    ChannelThreadFileShareEvent,
    SlackFiles,
    isSlackImageFile,
    SlackUser,
    Submission
} from './slack/api_interfaces';
import { store } from './../util/secrets';
import feature from './../util/feature';

function fileShareEventToIssueComment(
    event: ChannelThreadFileShareEvent,
    url: string,
    user_name: string
): string {
    const files_str = event.files.map(slackFileToText).join('\n\n');

    return `${user_name}: ${event.text}\n\n${files_str}\n \n${url}\n`;
}

interface SlackSupportCommand {
    name: string,
    desc: string,
    example: string
}

function supportCommandsNames(commands: Array<SlackSupportCommand>): Array<string> {
    return commands.map((cmd) => { return cmd.name; });
}

function supportCommandsHelpText(commands: Array<SlackSupportCommand>): string {
    return '👋 Need help with support bot?\n\n' + commands.map(
        (cmd) => {
            return `> ${cmd.desc}:\n>\`${cmd.example}\``;
        }).join('\n\n');
}

function viewToSubmission(
    view: ViewSubmission['view'],
    request_type: string
): Submission {
    const values = view.state.values;
    const submission: Submission = {};
    if (request_type === 'bug') {
        submission.title = values.sl_title_block.sl_title.value;
        submission.description = values.ml_description_block.ml_description.value;
        submission.currently = values.sl_currently_block.sl_currently.value;
        submission.expected = values.sl_expected_block.sl_expected.value;
    } else {
        submission.title = values.sl_title_block.sl_title.value;
        submission.description = values.ml_description_block.ml_description.value;
    }

    return submission;
}

// Unfortunaly preview slack images does not work as explained here:
// https://community.atlassian.com/t5/Jira-Questions/ \
// How-to-embed-images-by-URL-in-new-Markdown-Jira-editor/qaq-p/1126329
// > in the New editor and the editing view used in Next-gen Projects,
// > is moving away from using wiki style markup to a WYSIWYG editing approach,
// if (isSlackImageFile(file)) {
//     f = `!${file.url_private}!\n` +
//         `[Download](${file.url_private_download}) or ` +
//         `[See on Slack](${file.permalink})`;
// } else {
// }
function slackFileToText(file: SlackFiles): string {
    if (isSlackImageFile(file)) {
        return `${file.name}\n` +
            `Preview: ${file.thumb_360}\n` +
            `Show: ${file.url_private}\n` +
            `Download: ${file.url_private_download}`;
    } else {
        return `${file.name}\n` +
            `Download: ${file.url_private_download}`;
    }
}

const support = {
    showForm(
        slack: Slack,
        request_type: string,
        trigger_id: string
    ): Promise<WebAPICallResult> {
        const errorHandler = (error: Error): Promise<WebAPICallResult> => {
            logger.error('showForm', error.message);

            return Promise.reject({ ok: false });
        };

        if (feature.is_enabled('slack_modals')) {
            const view: View = supportConfig(support.configName(slack)).view(request_type);

            return slack.showModalView(view, trigger_id)
                .catch(errorHandler);
        } else {
            const dialog: Dialog = supportConfig(support.configName(slack)).dialogs[request_type];

            return slack.showDialog(dialog, trigger_id)
                .catch(errorHandler);
        }
    },

    postIssueUrlOnThread(
        slack: Slack,
        url: string,
        thread: SlackMessage
    ): Promise<SlackMessage> {
        const msg_text =
            `${url}\n` +
            'Thank You, we will post updates on this thread.';

        return slack.postOnThread(msg_text, thread.channel, thread.ts)
            .then((response) => {
                return Promise.resolve(response as SlackMessage);
            }).catch((error) => {
                logger.error('postIssueUrlOnThread', error.message);
                throw new Error('Unexpected error in postIssueUrlOnThread');
            });
    },

    createSupportRequest(
        slack: Slack,
        jira: Jira,
        submission: Submission,
        user: SlackUser,
        request_type: string
    ): void {
        const support_config = supportConfig(support.configName(slack));
        const message_text = support_config.supportMessageText(
            submission, user, request_type
        );
        const p1 = slack.postMessage(
            message_text,
            support.channel(slack)
        );
        const issue_params = support_config.issueParams(
            submission, user, request_type
        );
        const p2 = jira.createIssue(issue_params);

        p1.then((message) => {
            p2.then((issue) => {
                jira.addSlackThreadUrlToIssue(
                    slack.messageUrl(message),
                    issue
                );

                support.postIssueUrlOnThread(
                    slack,
                    jira.issueUrl(issue),
                    message
                );

                support.persist(
                    slack.toKey(message),
                    jira.toKey(issue)
                );
            });
        });
    },

    // slack_message, jira_issue
    persist(message_key: string, issue_key: string): void {
        store.set(
            message_key, issue_key,
            issue_key, message_key
        );
    },

    issueKey(team_id: string, channel_id: string, message_id: string): Promise<string> {
        const key = [team_id, channel_id, message_id].join(',');
        return store.get(key)
            .then((val) => {
                if (val === null) {
                    return Promise.reject(new Error(`Issue key not found: ${key}`));
                }
                return Promise.resolve(val.split(',').pop() as string);
            });
    },

    addFileToJiraIssue(
        slack: Slack,
        jira: Jira,
        event: ChannelThreadFileShareEvent
    ): void {
        support.issueKey(slack.id, event.channel, event.thread_ts)
            .then((issue_key: string) => {
                const user_name = slack.userName(event.user);
                const addComment = (name: string): void => {
                    const comment = fileShareEventToIssueComment(
                        event,
                        slack.threadMessageUrl(event),
                        name
                    );
                    jira.addComment(issue_key, comment);
                };
                user_name.then(addComment)
                    .catch(() => {
                        addComment(event.user);
                    });
            }).catch((error) => {
                logger.error(`addFileToJiraIssue: ${error}`);
            });
    },

    handleCommand(slack: Slack, payload: PostCommandPayload, res: Response): Response {
        const { text, trigger_id } = payload;
        const args = text.trim().split(/\s+/);
        const commands = supportConfig(support.configName(slack)).commands;
        const requests_types = supportCommandsNames(commands);
        if (requests_types.includes(args[0])) {
            support.showForm(slack, args[0], trigger_id);
            return res.status(200).send();
        } else if (args[0] === 'ping') {
            return res.json({
                response_type: 'ephemeral',
                text: 'Pong!'
            });
        }

        return res.json({
            text: supportCommandsHelpText(commands)
        });
    },

    handleDialogSubmission(
        slack: Slack,
        jira: Jira,
        payload: DialogSubmission,
        request_type: string,
        res: Response
    ): Response {
        const { user, submission } = payload;

        support.createSupportRequest(
            slack, jira, submission, user, request_type
        );

        return res;
    },

    handleViewSubmission(
        slack: Slack,
        jira: Jira,
        payload: ViewSubmission,
        request_type: string,
        res: Response
    ): Response {
        const { user, view } = payload;
        const submission = viewToSubmission(view, request_type);

        support.createSupportRequest(
            slack, jira, submission, user, request_type
        );

        return res;
    },

    configName: function(slack: Slack): string {
        return store.supportOptions(slack.id).config_name;
    },

    channel: function(slack: Slack): string {
        return store.supportOptions(slack.id).channel_id;
    }
};

export {
    fileShareEventToIssueComment,
    Submission,
    support
};
