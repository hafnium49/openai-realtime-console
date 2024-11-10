// schemas.js

export const functionSchemas = [
  {
    name: 'add_pickmove_task',
    description:
      'Adds a pick-and-move task to the controller manager. Picks up an object, moves it to a target position and hold. To release the object, follow this task with an "add_return_task". The "picking_object" and "target" define the initial and final positions of the task, respectively.',
    parameters: {
      type: 'object',
      properties: {
        picking_object: {
          type: 'string',
          enum: ['Bottle_Kmno4', 'Bottle_Fecl2', 'beaker_Fecl2', 'beaker_Kmno4'],
          description:
            'The name of the object to pick. This defines the initial position of the task.',
        },
        target: {
          oneOf: [
            {
              type: 'string',
              enum: ['Bottle_Kmno4', 'Bottle_Fecl2', 'beaker_Fecl2', 'beaker_Kmno4'],
              description:
                'The name of the target object to move to. This defines the final position of the task.',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description:
                'The numeric target position to move the object to. This defines the final position of the task.',
            },
          ],
          description: 'The target object name or position.',
        },
      },
      required: ['picking_object', 'target'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_pour_task',
    description:
      'Adds a pour task to the controller manager. This task performs a pouring action at the robot\'s current position. Note: The "picked_object" must be equivalent to the "picking_object" of the last step.',
    parameters: {
      type: 'object',
      properties: {
        picked_object: {
          type: 'string',
          enum: ['Bottle_Kmno4', 'Bottle_Fecl2', 'beaker_Fecl2', 'beaker_Kmno4'],
          description:
            'The name of the holding object. This defines the pour direction of the task.',
        },
      },
      required: ['picked_object'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_return_task',
    description:
      'Adds a return task to the controller manager. Assumes the robot is currently holding an object and performs a return action to the specified position. To pick up an object, call "add_pickmove_task" before this task. The "pour_position" and "return_position" define the initial and final positions of the task, respectively. Note: The "pour_position" must be equivalent to the final position of the last step (e.g., the "target" of the previous "add_pickmove_task").',
    parameters: {
      type: 'object',
      properties: {
        pour_position: {
          oneOf: [
            {
              type: 'string',
              enum: ['Bottle_Kmno4', 'Bottle_Fecl2', 'beaker_Fecl2', 'beaker_Kmno4'],
              description:
                'The name of the pour position object. This should be equivalent to the final position of the last task.',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description:
                'The numeric pour position. This should be equivalent to the final position of the last task.',
            },
          ],
          description: 'The pour position as object name or numeric position.',
        },
        return_position: {
          oneOf: [
            {
              type: 'string',
              enum: ['Bottle_Kmno4', 'Bottle_Fecl2', 'beaker_Fecl2', 'beaker_Kmno4'],
              description:
                'The name of the return position object. This defines the final position of the return task.',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description:
                'The numeric return position. This defines the final position of the return task.',
            },
          ],
          description: 'The return position as object name or numeric position.',
        },
      },
      required: ['pour_position', 'return_position'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_memory',
    description: 'Stores a key-value pair in the assistant\'s memory.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The key under which to store the value.',
        },
        value: {
          type: 'string',
          description: 'The value to store.',
        },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_weather',
    description: 'Retrieves weather information for a given location.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The location to get weather data for.',
        },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
];
