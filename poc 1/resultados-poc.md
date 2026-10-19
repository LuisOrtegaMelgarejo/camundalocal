POC SCOTIAFLOW-363 — Identificar el proceso principal desde un worker

# Contexto

En el marco de la plataforma ScotiaFlow, los tickets de negocio disparan y coordinan la ejecución de flujos de trabajo en Camunda. El proceso principal define el flujo de procesos centrales y es el encargado de invocar subprocesos mediante elementos de tipo Call Activity.

Tanto el proceso principal como los subprocesos invocados incorporan tareas de tipo usuario (User Tasks). En el esquema actual, estas User Tasks están configuradas con una implementación basada en job workers (io.camunda.zeebe:userTask), permitiendo que workers externos (por ejemplo, desarrollados en Node.js) escuchen, procesen y gestionen el trabajo asociado a dichas tareas.

# Problema

Cuando un job worker toma una tarea de tipo usuario para su procesamiento, requiere conocer el contexto operativo al que pertenece, fundamentalmente el número de ticket o los datos del proceso padre.

Sin embargo, cuando una tarea se ejecuta dentro de un subproceso hijo (invocado a través de una Call Activity), el subproceso no tiene forma intrínseca de conocer el ticket ni la información de contexto del proceso padre. Esto se debe a que el payload nativo del job incluye únicamente la información local del subproceso (processInstanceKey, processDefinitionKey, bpmnProcessId, elementId y sus variables), perdiendo la trazabilidad contextual hacia la instancia principal que le dio origen.

# Solución

## Exploración con Job Workers

Para analizar cómo resolver la pérdida de contexto, se realizó una exploración ejecutando job workers sobre un entorno de Camunda. Se determinaron las posibilidades y limitaciones del motor:

**Lo que NO es posible:**

Intercepción en Call Activity: La Call Activity no genera jobs por sí misma, por lo que un worker no puede interceptar el momento exacto de la invocación.

Lectura directa del Key padre desde el modelo: El processInstanceKey del padre no es una variable del proceso; por ende, no se puede acceder a él directamente desde el modelo BPMN mediante expresiones FEEL, Script Tasks o Input Mappings estándar.

Obtención automática en el payload: El payload nativo del job generado en el subproceso hijo no incluye ninguna referencia ni identificador del proceso padre.

**Lo que SÍ es posible:**

Consulta vía API REST v2: Se verificó que la API REST de Camunda (GET /v2/process-instances/{key}) permite consultar la instancia del hijo y obtener el parentProcessInstanceKey. Asimismo, la API ofrece el endpoint /call-hierarchy para jerarquías complejas.

Propagación y Mapeo de Variables: Es posible transferir variables de contexto desde el proceso principal hacia el subproceso hijo directamente en la definición de la Call Activity al momento de la invocación.

## Soluciones Posibles y Recomendación

Se evaluaron dos enfoques principales dentro del modelado BPMN para resolver la transferencia del contexto de datos:

**Segregación / Propagación Total de Variables (propagateAllParentVariables="true")**

Descripción: Copia automáticamente todas las variables presentes en la instancia del proceso padre hacia el subproceso hijo.

Desventaja: Transfiere datos innecesarios al subproceso (por ejemplo, variables temporales o de otros canales) y rompe la encapsulación del subproceso, aumentando el riesgo de colisiones o sobrescritura indeseada de variables.

**Mapeo Explícito de Entradas / Input Mapping (propagateAllParentVariables="false") — OPCIÓN RECOMENDADA**

Descripción: Se deshabilita la propagación automática de variables y se define explícitamente en la Call Activity qué variables específicas del padre se transferirán al hijo (por ejemplo, mapeando ticketNumber → ticket o ticketNumber → ticketNumber).

**Justificación de la Solución Elejida (Input Mapping)**

Se determinó que el Input Mapping es la solución ideal debido a que se alinea estrictamente con las buenas prácticas de arquitectura y modelado de procesos:

Principio de Mínimo Privilegio y Encapsulación: El subproceso hijo recibe únicamente los datos indispensables para su ejecución (el identificador del ticket y su contexto relevante), evitando contaminar su scope de variables con datos globales del padre.

Aislamiento e Inmutabilidad: Evita que el proceso padre pisotee o altere inadvertidamente variables internas del hijo, o viceversa, reduciendo efectos secundarios y acoplamientos innecesarios.

Documentación y Mantenibilidad Visible: Al estar explicitado en la configuración de la Call Activity, cualquier desarrollador o analista puede entender a simple vista la interfaz de entrada del subproceso (qué datos consume) sin necesidad de revisar el código de los workers.

Eficiencia Operativa: A diferencia de la alternativa vía API REST (que requeriría una llamada HTTP externa por cada tarea para consultar al padre), el Input Mapping incluye el ticket directamente en el payload inicial del job. El worker lee la variable de forma transparente, con costo cero de red y sin necesidad de incorporar Service Tasks o Listeners adicionales.

## Consideraciones Técnicas Adicionales

Momento de Inicialización: El número de ticket debe estar asignado en el proceso principal antes de alcanzar la Call Activity; de lo contrario, no se propagará al subproceso.

Alineación de Nombres de Variables: Si bien es posible renombrar la variable (ticketNumber a ticket), se recomienda mantener una convención homogénea (ticketNumber → ticketNumber) para que todos los workers del ecosistema consuman siempre la misma clave.

Ejecución Aislada: Si un subproceso es invocado de manera independiente (fuera del flujo principal), el worker debe contemplar que la variable de ticket podría no estar presente.

Tipos de Datos: Los identificadores de instancias (keys) generados por Camunda corresponden a enteros de 64 bits de gran tamaño, por lo que siempre deben ser tratados y manipulados como cadenas de texto (strings).

Depreciación de Implementación: Cabe revisar la documentación de versiones recientes de Camunda respecto al uso de la implementación job worker en User Tasks (io.camunda.zeebe:userTask), para evaluar el impacto a largo plazo sobre el Tasklist nativo y los workers integrados.